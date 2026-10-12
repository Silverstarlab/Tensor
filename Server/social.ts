import { randomBytes, randomUUID } from "node:crypto";
import type { Ctx } from "./context.js";
import { getUser, walletAccountId } from "./accounts.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import { post, SYS } from "./ledger.js";

const label = (id: string) => "크리에이터 " + String(id).slice(0, 4);

export async function setFollow(ctx: Ctx, userId: string, creatorId: string, on: boolean) {
  const c = (await ctx.db.query<any>("SELECT role FROM users WHERE id = $1", [creatorId]))[0];
  if (!c || c.role !== "creator") throw notFound("creator");
  if (creatorId === userId) throw badRequest("self_follow", "cannot follow yourself");
  if (on) await ctx.db.query("INSERT INTO follows (user_id, creator_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [userId, creatorId]);
  else await ctx.db.query("DELETE FROM follows WHERE user_id = $1 AND creator_id = $2", [userId, creatorId]);
  return { following: on };
}

export async function createPost(ctx: Ctx, creatorId: string, i: Record<string, unknown>) {
  const u = await getUser(ctx.db, creatorId);
  if (u.role !== "creator") throw forbidden("not_creator", "only creators can post");
  const body = typeof i.body === "string" ? i.body.trim() : "";
  if (!body || body.length > 2000) throw badRequest("invalid_body", "body must be 1..2000 characters");
  const vis = i.visibility;
  if (vis !== "FREE" && vis !== "SUB" && vis !== "PPV") throw badRequest("invalid_visibility", "visibility must be FREE, SUB or PPV");
  const category = typeof i.category === "string" && i.category.trim() ? i.category.trim().slice(0, 20) : null;
  const contentId = typeof i.contentId === "string" && i.contentId ? i.contentId : null;
  if (contentId) {
    const c = (await ctx.db.query<any>("SELECT creator_id FROM contents WHERE id = $1", [contentId]))[0];
    if (!c || c.creator_id !== creatorId) throw badRequest("invalid_content", "content not found or not yours");
  }
  // 이미지는 항상 열람자별 워터마크가 필요하므로 계정 없이 볼 수 있는 FREE 글에는 붙일 수 없다
  if (vis === "FREE" && contentId) throw badRequest("free_media_not_allowed", "free posts cannot include media");
  let price: number | null = null;
  if (vis === "PPV") {
    if (!contentId) throw badRequest("ppv_needs_content", "PPV posts need an image");
    price = i.ppvPriceCoins as number;
    if (!Number.isSafeInteger(price) || price <= 0) throw badRequest("invalid_price", "ppvPriceCoins must be a positive integer");
  }
  const id = randomUUID();
  await ctx.db.query("INSERT INTO posts (id,creator_id,body,category,visibility,ppv_price_coins,content_id) VALUES ($1,$2,$3,$4,$5,$6,$7)", [id, creatorId, body, category, vis, price, contentId]);
  return { postId: id };
}

export async function purchasePpv(ctx: Ctx, userId: string, postId: string) {
  try {
    return await ctx.db.transaction(async (tx) => {
      const p = (await tx.query<any>("SELECT id, creator_id, ppv_price_coins, visibility FROM posts WHERE id = $1", [postId]))[0];
      if (!p || p.visibility !== "PPV") throw notFound("ppv post");
      if (p.creator_id === userId) throw badRequest("self_purchase", "cannot purchase your own post");
      if ((await tx.query("SELECT 1 FROM ppv_purchases WHERE user_id = $1 AND post_id = $2", [userId, postId])).length) throw conflict("already_purchased", "already purchased");
      const price = Number(p.ppv_price_coins);
      const fee = Math.floor((price * ctx.cfg.feeBps) / 10_000);
      const id = randomUUID();
      const receiptId = "ppv_" + randomBytes(12).toString("hex");
      await tx.query("INSERT INTO ppv_purchases (id,user_id,post_id,receipt_id,price_coins) VALUES ($1,$2,$3,$4,$5)", [id, userId, postId, receiptId, price]);
      await post(tx, {
        idempotencyKey: `ppv:${id}`,
        type: "PPV_PURCHASE",
        entries: [
          { accountId: walletAccountId(userId), amount: -price },
          { accountId: walletAccountId(p.creator_id), amount: price - fee },
          { accountId: SYS.REVENUE, amount: fee },
        ],
        memo: { purchaseId: id, receiptId, postId, fee },
      });
      return { purchaseId: id, receiptId, priceCoins: price };
    });
  } catch (e: any) {
    if (e?.code === "23505") throw conflict("already_purchased", "already purchased");
    throw e;
  }
}

/** 게시글 목록. 잠긴 글은 본문과 contentId를 내려주지 않는다(서버에서 마스킹). viewerId=null 이면 비로그인 */
export async function listPosts(ctx: Ctx, viewerId: string | null, o: { creatorId?: string; feedOf?: string; visibility?: string; category?: string }) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => (params.push(v), where.push(sql.replace("?", `$${params.length}`)));
  if (o.creatorId) add("p.creator_id = ?", o.creatorId);
  if (o.feedOf) add("p.creator_id IN (SELECT creator_id FROM follows WHERE user_id = ?)", o.feedOf);
  if (o.visibility === "PPV") where.push("p.visibility = 'PPV'");
  else if (o.visibility === "FEED") where.push("p.visibility <> 'PPV'");
  if (o.category) add("p.category = ?", o.category);
  const rows = await ctx.db.query<any>(`SELECT p.* FROM posts p ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY p.created_at DESC LIMIT 50`, params);
  let subs = new Set<string>();
  let bought = new Set<string>();
  if (viewerId) {
    subs = new Set((await ctx.db.query<any>("SELECT DISTINCT p.creator_id FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.user_id = $1 AND s.status = 'ACTIVE' AND s.expires_at > now()", [viewerId])).map((r) => r.creator_id));
    bought = new Set((await ctx.db.query<any>("SELECT post_id FROM ppv_purchases WHERE user_id = $1", [viewerId])).map((r) => r.post_id));
  }
  return rows.map((r) => {
    const open = viewerId === r.creator_id || r.visibility === "FREE" || (r.visibility === "SUB" && subs.has(r.creator_id)) || (r.visibility === "PPV" && bought.has(r.id));
    return {
      postId: r.id, creatorId: r.creator_id, name: label(r.creator_id), visibility: r.visibility, category: r.category,
      createdAt: new Date(r.created_at).toISOString(), priceCoins: r.visibility === "PPV" ? Number(r.ppv_price_coins) : null,
      hasMedia: !!r.content_id, locked: !open, body: open ? r.body : null, contentId: open ? r.content_id : null,
    };
  });
}

export async function creatorProfile(ctx: Ctx, viewerId: string | null, creatorId: string) {
  const u = (await ctx.db.query<any>("SELECT id, role FROM users WHERE id = $1", [creatorId]))[0];
  if (!u || u.role !== "creator") throw notFound("creator");
  const plan = (await ctx.db.query<any>("SELECT id, price_coins, period_days, first_month_discount_bps FROM plans WHERE creator_id = $1 AND active ORDER BY created_at DESC LIMIT 1", [creatorId]))[0];
  const followers = Number((await ctx.db.query<any>("SELECT count(*) AS n FROM follows WHERE creator_id = $1", [creatorId]))[0].n);
  const cats = await ctx.db.query<any>("SELECT category, count(*) AS n FROM posts WHERE creator_id = $1 AND category IS NOT NULL AND visibility <> 'PPV' GROUP BY category ORDER BY n DESC LIMIT 12", [creatorId]);
  const cnt = (await ctx.db.query<any>("SELECT count(*) FILTER (WHERE visibility <> 'PPV') AS feed, count(*) FILTER (WHERE visibility = 'PPV') AS ppv FROM posts WHERE creator_id = $1", [creatorId]))[0];
  let following = false, subscribed = false, hadBefore = false;
  if (viewerId) {
    following = (await ctx.db.query("SELECT 1 FROM follows WHERE user_id = $1 AND creator_id = $2", [viewerId, creatorId])).length > 0;
    const s = await ctx.db.query<any>("SELECT s.status, s.expires_at FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.user_id = $1 AND p.creator_id = $2", [viewerId, creatorId]);
    hadBefore = s.length > 0;
    subscribed = s.some((x) => x.status === "ACTIVE" && new Date(x.expires_at) > new Date());
  }
  const price = plan ? Number(plan.price_coins) : 0;
  const bps = plan ? Number(plan.first_month_discount_bps) : 0;
  return {
    creatorId, name: label(creatorId), followers, following, subscribed,
    counts: { feed: Number(cnt.feed), ppv: Number(cnt.ppv) },
    categories: cats.map((c) => ({ name: c.category, count: Number(c.n) })),
    plan: plan ? { planId: plan.id, priceCoins: price, periodDays: Number(plan.period_days), discountBps: bps, firstMonthPriceCoins: !hadBefore && bps > 0 ? Math.max(1, Math.floor((price * (10_000 - bps)) / 10_000)) : null } : null,
  };
}
