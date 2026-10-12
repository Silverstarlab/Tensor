import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { timingSafeEqual } from "node:crypto";
import type { Ctx } from "./context.js";
import { getWallet, setKycStatus } from "./accounts.js";
import { signup, login, verifyToken } from "./auth.js";
import { createCharge, confirmCharge } from "./charges.js";
import { createPlan, subscribe, cancelSubscription, releaseDue } from "./subscriptions.js";
import { createContent, grantAccess, resolveDeliveryForMedia } from "./deliveries.js";
import { reportLeak, reviewLeak } from "./leaks.js";
import { requestPayout, cancelPayout, settleDuePayouts, type OffRamp } from "./payouts.js";
import { verifyLedger } from "./ledger.js";
import { uploadContent, serveMedia, analyzeLeakImage } from "./media.js";
import { isSafeKey, type ObjectStorage } from "./storage.js";
import type { WatermarkEngine } from "./watermark.js";
import { DomainError, badRequest, unauthorized } from "./errors.js";

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// 본문/파라미터는 각 핸들러에서 str()/num()으로 검증한다
type Req = Omit<FastifyRequest, "body" | "params"> & { body: any; params: any };

export interface AppOptions {
  logger?: boolean;
  /** 로드밸런서/프록시 뒤에서 실제 클라이언트 IP를 쓰려면 true (레이트 리밋 정확도에 필요) */
  trustProxy?: boolean;
  /** 이미지 전달/분석에 필요한 의존성. engine이 없으면 워터마크 없는 콘텐츠를 내보내지 않고 503을 돌려준다 */
  storage?: ObjectStorage;
  engine?: WatermarkEngine | null;
}

const LOG_REDACT = ["req.headers.authorization", 'req.headers["x-admin-key"]', 'req.headers["x-webhook-secret"]'];

export async function buildApp(ctx: Ctx, offramp: OffRamp, opts: AppOptions = {}) {
  const app = Fastify({
    logger: opts.logger ? { level: process.env.LOG_LEVEL ?? "info", redact: LOG_REDACT } : false,
    trustProxy: opts.trustProxy ?? false,
    bodyLimit: 100 * 1024,
  });
  await app.register(helmet);
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });
  // 원본 이미지 바이트를 그대로 받는 라우트용 파서 (본문 형식은 매직 바이트로 따로 검증한다)
  app.addContentTypeParser(["image/png", "image/jpeg", "image/webp", "application/octet-stream"], { parseAs: "buffer", bodyLimit: 25 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  const deps = { storage: opts.storage!, engine: opts.engine ?? null };
  const needStorage = () => {
    if (!opts.storage) throw new DomainError(503, "storage_unavailable", "object storage is not configured");
  };
  const limit = (max: number) => ({ config: { rateLimit: { max, timeWindow: "1 minute" } } });

  /** Authorization: Bearer <JWT> 에서 사용자 ID를 꺼낸다 */
  const userId = async (req: Req): Promise<string> => {
    const h = req.headers.authorization;
    if (typeof h !== "string" || !h.startsWith("Bearer ")) throw unauthorized("bearer token required");
    return (await verifyToken(ctx.cfg, h.slice(7))).userId;
  };
  const admin = (req: Req) => {
    const k = req.headers["x-admin-key"];
    if (typeof k !== "string" || !safeEq(k, ctx.cfg.adminKey)) throw unauthorized("admin key required");
  };
  const num = (v: unknown, name: string): number => {
    if (typeof v !== "number") throw badRequest("invalid_field", `${name} must be a number`);
    return v;
  };
  const str = (v: unknown, name: string): string => {
    if (typeof v !== "string" || !v) throw badRequest("invalid_field", `${name} must be a non-empty string`);
    return v;
  };

  app.setErrorHandler((err: any, _req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof DomainError)
      return reply.status(err.status).send({ error: err.code, message: err.message, details: err.details });
    // Fastify/플러그인이 만든 4xx(본문 크기 초과 413, 레이트 리밋 429, 잘못된 JSON 400 등)는 그대로 전달한다
    const sc = err?.statusCode;
    if (typeof sc === "number" && sc >= 400 && sc < 500)
      return reply.status(sc).send({ error: sc === 429 ? "rate_limited" : sc === 413 ? "payload_too_large" : "bad_request", message: err.message });
    app.log.error(err);
    return reply.status(500).send({ error: "internal_error" });
  });

  // 운영: /health = 프로세스 생존(liveness), /ready = DB 연결까지 확인(readiness)
  app.get("/health", async () => ({ ok: true }));
  app.get("/ready", async (_req: Req, reply: FastifyReply) => {
    try {
      await ctx.db.query("SELECT 1");
      return { ok: true };
    } catch {
      return reply.status(503).send({ ok: false });
    }
  });

  // 계정
  app.post("/auth/signup", limit(10), async (req: Req) =>
    signup(ctx, { email: str(req.body?.email, "email"), password: req.body?.password, role: req.body?.role, region: str(req.body?.region, "region") }),
  );
  app.post("/auth/login", limit(10), async (req: Req) => login(ctx, { email: str(req.body?.email, "email"), password: str(req.body?.password, "password") }));
  app.get("/me/wallet", async (req: Req) => getWallet(ctx, await userId(req)));

  // 충전 (결제 승인은 PG 웹훅이 확정)
  app.post("/charges", limit(20), async (req: Req) => createCharge(ctx, await userId(req), num(req.body?.coins, "coins")));
  app.post("/webhooks/pg/confirm", async (req: Req) => {
    const s = req.headers["x-webhook-secret"];
    if (typeof s !== "string" || !safeEq(s, ctx.cfg.webhookSecret)) throw unauthorized("invalid webhook secret");
    return confirmCharge(ctx, str(req.body?.chargeId, "chargeId"), str(req.body?.pgPaymentId, "pgPaymentId"));
  });

  // 플랜 / 구독
  app.post("/plans", async (req: Req) => createPlan(ctx, await userId(req), num(req.body?.priceCoins, "priceCoins"), num(req.body?.periodDays, "periodDays")));
  app.post("/subscriptions", async (req: Req) => subscribe(ctx, await userId(req), str(req.body?.planId, "planId")));
  app.post("/subscriptions/:id/cancel", async (req: Req) => cancelSubscription(ctx, await userId(req), req.params.id));

  // 콘텐츠
  app.post("/contents", async (req: Req) => {
    const key = str(req.body?.storageKey, "storageKey");
    if (!isSafeKey(key)) throw badRequest("unsafe_storage_key", "storageKey contains forbidden characters or path segments");
    return createContent(ctx, await userId(req), { kind: req.body?.kind, storageKey: key, sha256: req.body?.sha256 });
  });
  // 원본 이미지 업로드 (본문 = 이미지 바이트)
  app.post("/contents/upload", { bodyLimit: 25 * 1024 * 1024, ...limit(30) }, async (req: Req) => {
    needStorage();
    return uploadContent(ctx, deps, await userId(req), req.body as Buffer);
  });
  // 워터마크가 삽입된 이미지 전달. 인증은 서명 URL 자체가 대신한다(구독자별, 단기 만료).
  app.get("/media/:id", limit(120), async (req: any, reply: FastifyReply) => {
    needStorage();
    const q = req.query ?? {};
    const out = await serveMedia(ctx, deps, { contentId: req.params.id, deliveryId: String(q.d ?? ""), exp: Number(q.exp), sig: String(q.sig ?? "") });
    return reply
      .header("content-type", out.contentType)
      .header("cache-control", "private, no-store")
      .header("content-disposition", "inline")
      .send(out.data);
  });
  app.get("/contents/:id/access", limit(120), async (req: Req) => {
    const g = await grantAccess(ctx, await userId(req), req.params.id);
    return { url: g.url, expiresAt: g.expiresAt }; // wmId는 클라이언트에 절대 노출하지 않는다
  });

  // 출금
  app.post("/payouts", limit(10), async (req: Req) => requestPayout(ctx, await userId(req), num(req.body?.coins, "coins")));

  // 관리자 / 내부
  app.post("/admin/kyc", async (req: Req) => {
    admin(req);
    await setKycStatus(ctx, str(req.body?.userId, "userId"), req.body?.status);
    return { ok: true };
  });
  app.post("/admin/jobs/release-escrow", async (req: Req) => (admin(req), releaseDue(ctx)));
  app.post("/admin/jobs/settle-payouts", async (req: Req) => (admin(req), settleDuePayouts(ctx, offramp)));
  app.post("/admin/payouts/:id/cancel", async (req: Req) => (admin(req), cancelPayout(ctx, req.params.id)));
  app.post("/admin/leaks", async (req: Req) => {
    admin(req);
    return reportLeak(ctx, {
      wmId: str(req.body?.wmId, "wmId"),
      sourceUrl: str(req.body?.sourceUrl, "sourceUrl"),
      confidence: num(req.body?.confidence, "confidence"),
      contentId: req.body?.contentId,
    });
  });
  app.post("/admin/leaks/:id/review", async (req: Req) => {
    admin(req);
    await reviewLeak(ctx, req.params.id, req.body?.status);
    return { ok: true };
  });
  // 유출 의심 이미지 분석 (본문 = 이미지 바이트, 쿼리: sourceUrl, contentId?)
  app.post("/admin/leaks/analyze", { bodyLimit: 25 * 1024 * 1024 }, async (req: any) => {
    admin(req);
    needStorage();
    return analyzeLeakImage(ctx, deps, req.body as Buffer, { sourceUrl: String(req.query?.sourceUrl ?? ""), contentId: req.query?.contentId });
  });
  app.get("/admin/ledger/verify", async (req: Req) => (admin(req), verifyLedger(ctx.db)));
  // 미디어 서버가 서명 URL을 검증하고 삽입할 wm_id를 받아가는 내부 API
  app.post("/internal/media/resolve", async (req: Req) => {
    admin(req);
    const b = req.body ?? {};
    return resolveDeliveryForMedia(ctx, { contentId: str(b.contentId, "contentId"), deliveryId: str(b.deliveryId, "deliveryId"), exp: num(b.exp, "exp"), sig: str(b.sig, "sig") });
  });

  return app;
}
