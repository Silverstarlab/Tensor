import { randomBytes, randomUUID } from "node:crypto";
import type { Ctx } from "./context.js";
import type { Tx } from "./db.js";
import { getUser, walletAccountId } from "./accounts.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import { post, SYS } from "./ledger.js";

const DAY_MS = 86_400_000;

export async function createPlan(ctx: Ctx, creatorId: string, priceCoins: number, periodDays: number, firstMonthDiscountBps = 0) {
  const u = await getUser(ctx.db, creatorId);
  if (u.role !== "creator") throw forbidden("not_creator", "only creators can create plans");
  if (!Number.isSafeInteger(priceCoins) || priceCoins <= 0) throw badRequest("invalid_price", "priceCoins must be a positive integer");
  if (!Number.isSafeInteger(periodDays) || periodDays <= 0 || periodDays > 366)
    throw badRequest("invalid_period", "periodDays must be between 1 and 366");
  if (!Number.isSafeInteger(firstMonthDiscountBps) || firstMonthDiscountBps < 0 || firstMonthDiscountBps > 9000)
    throw badRequest("invalid_discount", "firstMonthDiscountBps must be an integer between 0 and 9000");
  const id = randomUUID();
  await ctx.db.query("INSERT INTO plans (id,creator_id,price_coins,period_days,first_month_discount_bps) VALUES ($1,$2,$3,$4,$5)", [
    id,
    creatorId,
    priceCoins,
    periodDays,
    firstMonthDiscountBps,
  ]);
  return { planId: id };
}

/**
 * 에스크로 일할 정산: 경과 일수에 비례한 누적 목표액까지 에스크로 -> 크리에이터(수수료 제외) + 플랫폼 수익.
 * 멱등성 키에 누적 목표액을 넣어 재실행해도 중복 정산되지 않는다.
 */
async function settleOne(tx: Tx, ctx: Ctx, subId: string, now: Date): Promise<void> {
  const rows = await tx.query<any>(
    `SELECT s.id, s.status, s.expires_at, p.creator_id, e.total, e.released, e.refunded, e.days, e.start_at
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       JOIN escrow_schedules e ON e.subscription_id = s.id
      WHERE s.id = $1 FOR UPDATE OF s, e`,
    [subId],
  );
  const s = rows[0];
  if (!s || s.status !== "ACTIVE") return;

  const elapsedDays = Math.min(s.days, Math.max(0, Math.floor((now.getTime() - new Date(s.start_at).getTime()) / DAY_MS)));
  const target = Math.floor((s.total * elapsedDays) / s.days);
  const delta = target - s.released;
  if (delta > 0) {
    const fee = Math.floor((delta * ctx.cfg.feeBps) / 10_000);
    await post(tx, {
      idempotencyKey: `release:${subId}:${target}`,
      type: "ESCROW_RELEASE",
      entries: [
        { accountId: SYS.ESCROW, amount: -delta },
        { accountId: walletAccountId(s.creator_id), amount: delta - fee },
        { accountId: SYS.REVENUE, amount: fee },
      ],
      memo: { subscriptionId: subId, elapsedDays, fee },
    });
    await tx.query("UPDATE escrow_schedules SET released = $1 WHERE subscription_id = $2", [target, subId]);
  }
  if (now >= new Date(s.expires_at) && target === s.total) {
    await tx.query("UPDATE subscriptions SET status = 'EXPIRED' WHERE id = $1", [subId]);
  }
}

export async function subscribe(ctx: Ctx, userId: string, planId: string, now = new Date()) {
  try {
    return await subscribeTx(ctx, userId, planId, now);
  } catch (e: any) {
    // 동시 요청(더블 클릭 등)이 DB 고유 인덱스에서 막힌 경우도 정상적인 충돌 응답으로 바꾼다
    if (e?.code === "23505" && String(e.message).includes("one_active_sub"))
      throw conflict("already_subscribed", "an active subscription already exists");
    throw e;
  }
}

async function subscribeTx(ctx: Ctx, userId: string, planId: string, now: Date) {
  return ctx.db.transaction(async (tx) => {
    const user = await getUser(tx, userId);
    const plans = await tx.query<any>("SELECT * FROM plans WHERE id = $1", [planId]);
    const plan = plans[0];
    if (!plan || !plan.active) throw notFound("plan");
    if (plan.creator_id === userId) throw badRequest("self_subscribe", "cannot subscribe to your own plan");

    // 만료됐지만 아직 정리되지 않은 같은 플랜 구독이 있으면 먼저 정산해 EXPIRED로 만든다(갱신 허용)
    const prev = await tx.query<{ id: string }>(
      "SELECT id FROM subscriptions WHERE user_id = $1 AND plan_id = $2 AND status = 'ACTIVE'",
      [userId, planId],
    );
    for (const p of prev) await settleOne(tx, ctx, p.id, now);
    const still = await tx.query("SELECT 1 FROM subscriptions WHERE user_id=$1 AND plan_id=$2 AND status='ACTIVE'", [userId, planId]);
    if (still.length) throw conflict("already_subscribed", "an active subscription already exists");

    // 첫 달 할인: 이 크리에이터의 어떤 플랜이든 구독한 적이 없는 사용자에게만 적용(적용 금액이 에스크로 총액이 된다)
    const hadBefore = (await tx.query("SELECT 1 FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.user_id = $1 AND p.creator_id = $2 LIMIT 1", [userId, plan.creator_id])).length > 0;
    const bps = Number(plan.first_month_discount_bps ?? 0);
    const charge = !hadBefore && bps > 0 ? Math.max(1, Math.floor((Number(plan.price_coins) * (10_000 - bps)) / 10_000)) : Number(plan.price_coins);
    const subId = randomUUID();
    const receiptId = "rcpt_" + randomBytes(12).toString("hex");
    const expires = new Date(now.getTime() + plan.period_days * DAY_MS);
    await tx.query(
      "INSERT INTO subscriptions (id,user_id,plan_id,receipt_id,started_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [subId, userId, planId, receiptId, now, expires],
    );
    await tx.query(
      "INSERT INTO escrow_schedules (subscription_id,total,days,start_at) VALUES ($1,$2,$3,$4)",
      [subId, charge, plan.period_days, now],
    );
    await post(tx, {
      idempotencyKey: `sub:${subId}`,
      type: "SUBSCRIBE",
      entries: [
        { accountId: walletAccountId(userId), amount: -charge },
        { accountId: SYS.ESCROW, amount: charge },
      ],
      memo: { subscriptionId: subId, receiptId, planId, region: user.region, listPrice: Number(plan.price_coins), firstMonthDiscount: charge !== Number(plan.price_coins) },
    });
    return { subscriptionId: subId, receiptId, expiresAt: expires.toISOString(), priceCoins: charge };
  });
}

/** 해지: 경과분은 크리에이터에게 정산하고 미정산 잔여분은 구독자에게 환불(일할). 환불 정책은 열린 이슈(16.6). */
export async function cancelSubscription(ctx: Ctx, userId: string, subId: string, now = new Date()) {
  return ctx.db.transaction(async (tx) => {
    const r = await tx.query<any>("SELECT user_id, status FROM subscriptions WHERE id = $1", [subId]);
    if (!r[0] || r[0].user_id !== userId) throw notFound("subscription");
    await settleOne(tx, ctx, subId, now);
    const cur = await tx.query<any>("SELECT status FROM subscriptions WHERE id = $1", [subId]);
    if (cur[0].status !== "ACTIVE") throw conflict("not_active", `subscription is ${cur[0].status}`);

    const e = (await tx.query<any>("SELECT total, released, refunded FROM escrow_schedules WHERE subscription_id = $1 FOR UPDATE", [subId]))[0];
    const refund = e.total - e.released - e.refunded;
    if (refund > 0) {
      await post(tx, {
        idempotencyKey: `refund:${subId}`,
        type: "SUBSCRIPTION_REFUND",
        entries: [
          { accountId: SYS.ESCROW, amount: -refund },
          { accountId: walletAccountId(userId), amount: refund },
        ],
        memo: { subscriptionId: subId },
      });
      await tx.query("UPDATE escrow_schedules SET refunded = refunded + $1 WHERE subscription_id = $2", [refund, subId]);
    }
    await tx.query("UPDATE subscriptions SET status='CANCELLED', cancelled_at=$1 WHERE id=$2", [now, subId]);
    return { refundedCoins: refund };
  });
}

/** 정산 배치(예: 매일 1회). 활성 구독 전체를 처리한다. */
export async function releaseDue(ctx: Ctx, now = new Date()) {
  const ids = await ctx.db.query<{ id: string }>("SELECT id FROM subscriptions WHERE status = 'ACTIVE' ORDER BY id");
  for (const { id } of ids) await ctx.db.transaction((tx) => settleOne(tx, ctx, id, now));
  return { processed: ids.length };
}
