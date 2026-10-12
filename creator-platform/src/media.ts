import { randomUUID } from "node:crypto";
import type { Ctx } from "./context.js";
import { resolveDeliveryForMedia } from "./deliveries.js";
import { DomainError, badRequest, forbidden, notFound } from "./errors.js";
import { reportLeak } from "./leaks.js";
import { sniffImage, type ObjectStorage } from "./storage.js";
import { WatermarkError, type WatermarkEngine } from "./watermark.js";

export interface MediaDeps {
  storage: ObjectStorage;
  engine: WatermarkEngine | null;
}

const MAX_UPLOAD = 25 * 1024 * 1024;
const MAX_CANDIDATES = 2_000_000;

/** 크리에이터 원본 업로드. 형식은 매직 바이트로 검증하고, 원본은 서명 URL 없이는 어디서도 접근할 수 없는 비공개 키에 둔다. */
export async function uploadContent(ctx: Ctx, deps: MediaDeps, creatorId: string, body: Buffer) {
  const owner = (await ctx.db.query<{ role: string }>("SELECT role FROM users WHERE id = $1", [creatorId]))[0];
  if (!owner) throw notFound("user");
  if (owner.role !== "creator") throw forbidden("not_creator", "only creators can upload content");
  if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest("empty_body", "image body required");
  if (body.length > MAX_UPLOAD) throw new DomainError(413, "payload_too_large", "image too large");
  const fmt = sniffImage(body);
  if (!fmt) throw new DomainError(415, "unsupported_media_type", "only PNG, JPEG, WebP images are supported");

  const id = randomUUID();
  const key = `originals/${id}.${fmt}`;
  await deps.storage.put(key, body);
  const { createHash } = await import("node:crypto");
  await ctx.db.query("INSERT INTO contents (id,creator_id,kind,storage_key,sha256) VALUES ($1,$2,'image',$3,$4)", [
    id,
    creatorId,
    key,
    createHash("sha256").update(body).digest("hex"),
  ]);
  return { contentId: id, format: fmt, bytes: body.length };
}

/**
 * 서명 URL을 검증하고, 구독자별 워터마크를 삽입한 이미지를 돌려준다.
 * - 엔진이 없으면 워터마크 없는 원본을 절대 내보내지 않고 실패한다(fail closed).
 * - 같은 구독자/콘텐츠 조합은 결정적으로 같은 wm_id라 결과를 저장소에 캐시한다.
 */
export async function serveMedia(
  ctx: Ctx,
  deps: MediaDeps,
  p: { contentId: string; deliveryId: string; exp: number; sig: string },
  now = new Date(),
): Promise<{ data: Buffer; contentType: string }> {
  const { wmId } = await resolveDeliveryForMedia(ctx, p, now);
  const c = (await ctx.db.query<{ kind: string; storage_key: string }>("SELECT kind, storage_key FROM contents WHERE id = $1", [p.contentId]))[0];
  if (!c) throw notFound("content");
  if (c.kind !== "image") throw new DomainError(501, "not_implemented", "only images are supported yet");

  const original = await deps.storage.get(c.storage_key);
  if (!original) throw notFound("content file");

  if (wmId === null) {
    // 크리에이터 본인의 미리보기: 워터마크 없이 원본을 그대로
    const fmt = sniffImage(original);
    return { data: original, contentType: fmt ? `image/${fmt}` : "application/octet-stream" };
  }
  if (!deps.engine) throw new DomainError(503, "watermark_engine_unavailable", "watermarking is unavailable; refusing to serve unmarked content");

  const fmt = ctx.cfg.mediaFormat;
  const cacheKey = `wm/${wmId}.${fmt === "png" ? "png" : "jpg"}`;
  const cached = await deps.storage.get(cacheKey);
  if (cached) return { data: cached, contentType: fmt === "png" ? "image/png" : "image/jpeg" };

  try {
    const out = await deps.engine.embed(original, wmId, { format: fmt });
    await deps.storage.put(cacheKey, out.data);
    return out;
  } catch (e) {
    if (e instanceof WatermarkError) {
      if (e.kind === "unsupported_image") throw new DomainError(422, "unsupported_image", e.message);
      throw new DomainError(503, "watermark_engine_unavailable", "watermarking is unavailable; refusing to serve unmarked content");
    }
    throw e;
  }
}

/**
 * 유출 의심 이미지 분석: 이 콘텐츠(또는 전체)에 대해 발급된 wm_id 후보와 대조하고,
 * 통계적으로 유의하면 유출 신고를 만들어 구독자를 특정한다. 자동 제재는 하지 않고 검수 대기(OPEN)로 둔다.
 */
export async function analyzeLeakImage(
  ctx: Ctx,
  deps: MediaDeps,
  image: Buffer,
  input: { sourceUrl: string; contentId?: string },
) {
  if (!deps.engine) throw new DomainError(503, "watermark_engine_unavailable", "watermark engine unavailable");
  if (!input.sourceUrl) throw badRequest("missing_source_url", "sourceUrl is required");
  if (!sniffImage(image)) throw new DomainError(415, "unsupported_media_type", "only PNG, JPEG, WebP images are supported");

  const rows = input.contentId
    ? await ctx.db.query<{ wm_id: string }>("SELECT wm_id FROM deliveries WHERE content_id = $1", [input.contentId])
    : await ctx.db.query<{ wm_id: string }>("SELECT wm_id FROM deliveries LIMIT $1", [MAX_CANDIDATES]);
  const candidates = rows.map((r) => r.wm_id);
  if (candidates.length === 0) return { detected: false as const, reason: "no_candidates", nCandidates: 0 };

  let a;
  try {
    a = await deps.engine.analyze(image, candidates);
  } catch (e) {
    if (e instanceof WatermarkError) {
      if (e.kind === "unsupported_image") throw new DomainError(422, "unsupported_image", e.message);
      throw new DomainError(503, "watermark_engine_unavailable", "watermark engine unavailable");
    }
    throw e;
  }
  if (!a.detected || !a.wmId) return { detected: false as const, reason: a.reason ?? "no_significant_match", z: a.z, threshold: a.threshold, nCandidates: a.nCandidates };

  const report = await reportLeak(ctx, {
    wmId: a.wmId,
    sourceUrl: input.sourceUrl,
    contentId: input.contentId,
    confidence: Math.min(1, Math.max(0, 1 - (a.pValue ?? 1))),
    zScore: a.z ?? undefined,
    detail: { threshold: a.threshold, pValue: a.pValue, nCandidates: a.nCandidates },
  });
  return { detected: true as const, z: a.z, threshold: a.threshold, pValue: a.pValue, nCandidates: a.nCandidates, ...report };
}
