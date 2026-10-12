import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { Ctx } from "./context.js";
import { PRICES } from "./pricing.js";
import { DomainError } from "./errors.js";
import { setFollow, createPost, purchasePpv, listPosts, creatorProfile } from "./social.js";

/**
 * 웹 프런트엔드가 필요로 하는 조회용 라우트 + 정적 페이지.
 * app.ts 의 buildApp 끝(return app 직전)에서 registerBrowse(app, ctx, userId) 로 등록한다.
 * 크리에이터 이메일 등 개인정보는 응답에 포함하지 않는다.
 */
export async function registerBrowse(app: FastifyInstance, ctx: Ctx, userId: (req: any) => Promise<string>) {
  const page = new URL("../web/index.html", import.meta.url);
  app.get("/", async (_req, reply) =>
    reply
      .type("text/html; charset=utf-8")
      .header("content-security-policy", "default-src 'self'; img-src 'self' http: https: data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'")
      .send(await readFile(page)),
  );
  // 로그인 없이도 볼 수 있는 조회는 토큰이 있으면 열람 상태(구독/구매)를 반영한다
  const optUser = async (req: any): Promise<string | null> => (typeof req.headers.authorization === "string" ? userId(req).catch(() => null) : null);
  app.get("/creators/:id", async (req: any) => creatorProfile(ctx, await optUser(req), String(req.params.id)));
  app.get("/creators/:id/posts", async (req: any) =>
    listPosts(ctx, await optUser(req), { creatorId: String(req.params.id), visibility: req.query?.tab === "ppv" ? "PPV" : "FEED", category: req.query?.category ? String(req.query.category) : undefined }),
  );
  app.get("/me/feed", async (req: any) => { const u = await userId(req); return listPosts(ctx, u, { feedOf: u, visibility: "FEED" }); });
  app.post("/creators/:id/follow", async (req: any) => setFollow(ctx, await userId(req), String(req.params.id), true));
  app.post("/creators/:id/unfollow", async (req: any) => setFollow(ctx, await userId(req), String(req.params.id), false));
  app.post("/posts", async (req: any) => createPost(ctx, await userId(req), req.body ?? {}));
  app.post("/posts/:id/purchase", async (req: any) => purchasePpv(ctx, await userId(req), String(req.params.id)));
  app.get("/prices", async () => PRICES);
  app.get("/me", async (req) => {
    const u = await userId(req);
    const r = (await ctx.db.query<any>("SELECT id, role, region, kyc_status FROM users WHERE id = $1", [u]))[0];
    if (!r) throw new DomainError(404, "not_found", "user not found");
    return { userId: r.id, role: r.role, region: r.region, kycStatus: r.kyc_status };
  });

  app.get("/creators", async () => {
    const rows = await ctx.db.query<any>("SELECT id, creator_id, price_coins, period_days, first_month_discount_bps FROM plans WHERE active ORDER BY created_at DESC LIMIT 100");
    return rows.map((r) => ({ planId: r.id, creatorId: r.creator_id, name: "크리에이터 " + String(r.creator_id).slice(0, 4), priceCoins: Number(r.price_coins), periodDays: Number(r.period_days), discountBps: Number(r.first_month_discount_bps) }));
  });

  app.get("/me/subscriptions", async (req) => {
    const u = await userId(req);
    const rows = await ctx.db.query<any>(
      "SELECT s.id, s.status, s.expires_at, p.creator_id, p.price_coins FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.user_id = $1 ORDER BY s.started_at DESC LIMIT 100",
      [u],
    );
    return rows.map((r) => ({ subscriptionId: r.id, status: r.status, expiresAt: new Date(r.expires_at).toISOString(), creatorId: r.creator_id, name: "크리에이터 " + String(r.creator_id).slice(0, 4), priceCoins: Number(r.price_coins) }));
  });

  // 활성 구독자(또는 크리에이터 본인)만 콘텐츠 목록을 볼 수 있다. 실제 이미지는 /contents/:id/access 의 서명 URL로만 받는다.
  app.get("/creators/:id/contents", async (req: any) => {
    const u = await userId(req);
    const cid = String(req.params.id);
    if (u !== cid) {
      const ok = await ctx.db.query("SELECT 1 FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.user_id = $1 AND p.creator_id = $2 AND s.status = 'ACTIVE' AND s.expires_at > now() LIMIT 1", [u, cid]);
      if (!ok[0]) throw new DomainError(403, "not_subscribed", "active subscription required");
    }
    const rows = await ctx.db.query<any>("SELECT id, kind, created_at FROM contents WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 200", [cid]);
    return rows.map((r) => ({ contentId: r.id, kind: r.kind, createdAt: new Date(r.created_at).toISOString() }));
  });
}
