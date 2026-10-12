import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Ctx } from "./context.js";
import type { Config } from "./config.js";
import { getUser } from "./accounts.js";
import { badRequest, forbidden, notFound } from "./errors.js";

export async function createContent(
  ctx: Ctx,
  creatorId: string,
  input: { kind: "image" | "video"; storageKey: string; sha256?: string },
) {
  const u = await getUser(ctx.db, creatorId);
  if (u.role !== "creator") throw forbidden("not_creator", "only creators can upload content");
  if (input.kind !== "image" && input.kind !== "video") throw badRequest("invalid_kind", "kind must be image or video");
  if (!input.storageKey) throw badRequest("missing_storage_key", "storageKey is required");
  const id = randomUUID();
  await ctx.db.query("INSERT INTO contents (id,creator_id,kind,storage_key,sha256) VALUES ($1,$2,$3,$4,$5)", [
    id,
    creatorId,
    input.kind,
    input.storageKey,
    input.sha256 ?? null,
  ]);
  return { contentId: id };
}

/** wm_id = HMAC(비밀키, receipt_id|content_id)의 앞 64비트. 비밀키 없이는 구독자와 연결할 수 없다. */
export function computeWmId(cfg: Config, receiptId: string, contentId: string): string {
  return createHmac("sha256", cfg.wmSecret).update(`${receiptId}|${contentId}`).digest("hex").slice(0, 16);
}

const b64url = (b: Buffer) => b.toString("base64url");
function sign(cfg: Config, payload: string) {
  return b64url(createHmac("sha256", cfg.urlSecret).update(payload).digest());
}

export function verifyMediaUrl(
  cfg: Config,
  p: { contentId: string; deliveryId: string; exp: number; sig: string },
  now = new Date(),
): boolean {
  if (now.getTime() / 1000 > p.exp) return false;
  const expected = Buffer.from(sign(cfg, `${p.contentId}.${p.deliveryId}.${p.exp}`));
  const given = Buffer.from(p.sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * 콘텐츠 열람 권한 확인 -> 전달 기록 -> 만료 서명 URL 발급.
 * 미디어 서버는 URL의 deliveryId로 wm_id를 조회해 원본에 워터마크를 삽입한 뒤 내려준다.
 */
export async function grantAccess(ctx: Ctx, userId: string, contentId: string, now = new Date()) {
  return ctx.db.transaction(async (tx) => {
    const c = (await tx.query<any>("SELECT id, creator_id FROM contents WHERE id = $1", [contentId]))[0];
    if (!c) throw notFound("content");

    const exp = Math.floor(now.getTime() / 1000) + ctx.cfg.signedUrlTtlSec;
    const mk = (deliveryId: string) => ({
      url: `${ctx.cfg.mediaBaseUrl}/media/${contentId}?d=${deliveryId}&exp=${exp}&sig=${sign(ctx.cfg, `${contentId}.${deliveryId}.${exp}`)}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    });

    // 크리에이터 본인 미리보기: 워터마크 없음, 전달 기록 없음
    if (c.creator_id === userId) return { ...mk("owner"), owner: true as const, wmId: null };

    const sub = (
      await tx.query<any>(
        `SELECT s.id, s.receipt_id FROM subscriptions s JOIN plans p ON p.id = s.plan_id
          WHERE s.user_id = $1 AND p.creator_id = $2 AND s.status = 'ACTIVE' AND s.expires_at > $3
          ORDER BY s.started_at DESC LIMIT 1`,
        [userId, c.creator_id, now],
      )
    )[0];
    if (!sub) throw forbidden("not_subscribed", "an active subscription is required");

    const wmId = computeWmId(ctx.cfg, sub.receipt_id, contentId);
    const existing = (await tx.query<any>("SELECT id FROM deliveries WHERE receipt_id = $1 AND content_id = $2", [sub.receipt_id, contentId]))[0];
    let deliveryId: string;
    if (existing) {
      deliveryId = existing.id;
      await tx.query("UPDATE deliveries SET access_count = access_count + 1, last_at = $1 WHERE id = $2", [now, deliveryId]);
    } else {
      deliveryId = randomUUID();
      await tx.query(
        "INSERT INTO deliveries (id,receipt_id,content_id,subscription_id,user_id,wm_id,first_at,last_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)",
        [deliveryId, sub.receipt_id, contentId, sub.id, userId, wmId, now],
      );
    }
    return { ...mk(deliveryId), owner: false as const, wmId };
  });
}

/** 미디어 서버용: URL 검증 후 삽입할 wm_id를 돌려준다. */
export async function resolveDeliveryForMedia(
  ctx: Ctx,
  p: { contentId: string; deliveryId: string; exp: number; sig: string },
  now = new Date(),
) {
  if (!verifyMediaUrl(ctx.cfg, p, now)) throw forbidden("invalid_or_expired_url", "signed url is invalid or expired");
  if (p.deliveryId === "owner") return { wmId: null };
  const d = (await ctx.db.query<any>("SELECT wm_id, content_id FROM deliveries WHERE id = $1", [p.deliveryId]))[0];
  if (!d || d.content_id !== p.contentId) throw notFound("delivery");
  return { wmId: d.wm_id as string };
}
