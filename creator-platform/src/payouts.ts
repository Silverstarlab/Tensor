import { randomUUID } from "node:crypto";
import type { Ctx } from "./context.js";
import { getUser, walletAccountId } from "./accounts.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import { post, SYS } from "./ledger.js";
import { priceFor } from "./pricing.js";

const DAY_MS = 86_400_000;
const MAX_ATTEMPTS = 5;

/** 외부 오프램프 파트너(스테이블코인 -> 현지 통화). 같은 idempotencyKey로 재호출해도 한 번만 지급되어야 한다. */
export interface OffRamp {
  pay(req: { idempotencyKey: string; currency: string; amountMinor: number; creatorId: string }): Promise<{ externalId: string }>;
}

export class MockOffRamp implements OffRamp {
  calls: Array<{ idempotencyKey: string; currency: string; amountMinor: number; creatorId: string }> = [];
  failNext = 0;
  async pay(req: { idempotencyKey: string; currency: string; amountMinor: number; creatorId: string }) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("offramp unavailable");
    }
    if (!this.calls.some((c) => c.idempotencyKey === req.idempotencyKey)) this.calls.push(req);
    return { externalId: "mock_" + req.idempotencyKey };
  }
}

/** 출금 신청: 코인을 PAYOUT_HOLD로 옮겨 묶고, 보류 기간(환불/차지백/분쟁 정리) 후 정산한다. */
export async function requestPayout(ctx: Ctx, creatorId: string, coins: number, now = new Date()) {
  return ctx.db.transaction(async (tx) => {
    const u = await getUser(tx, creatorId);
    if (u.role !== "creator") throw forbidden("not_creator", "only creators can request payouts");
    if (u.kyc_status !== "VERIFIED") throw forbidden("kyc_required", "identity verification is required for payouts");
    if (!Number.isSafeInteger(coins) || coins < ctx.cfg.minPayoutCoins)
      throw badRequest("below_minimum", `minimum payout is ${ctx.cfg.minPayoutCoins} coins`);

    // TODO: 코인 -> 현지 통화 환산은 FX 모듈(환율 확정)로 교체. 지금은 지역 가격표를 그대로 사용한다.
    const price = priceFor(u.region)!;
    const id = randomUUID();
    const releaseAt = new Date(now.getTime() + ctx.cfg.payoutHoldDays * DAY_MS);
    await post(tx, {
      idempotencyKey: `payout:${id}:hold`,
      type: "PAYOUT_HOLD",
      entries: [
        { accountId: walletAccountId(creatorId), amount: -coins },
        { accountId: SYS.PAYOUT_HOLD, amount: coins },
      ],
      memo: { payoutId: id },
    });
    await tx.query(
      "INSERT INTO payouts (id,creator_id,coins,currency,amount_minor,price_version,release_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [id, creatorId, coins, price.currency, coins * price.minorPerCoin, price.version, releaseAt],
    );
    return { payoutId: id, coins, currency: price.currency, amountMinor: coins * price.minorPerCoin, releaseAt: releaseAt.toISOString() };
  });
}

export async function cancelPayout(ctx: Ctx, payoutId: string) {
  return ctx.db.transaction(async (tx) => {
    const p = (await tx.query<any>("SELECT * FROM payouts WHERE id = $1 FOR UPDATE", [payoutId]))[0];
    if (!p) throw notFound("payout");
    if (p.status !== "PENDING") throw conflict("not_pending", `payout is ${p.status}`);
    await post(tx, {
      idempotencyKey: `payout:${payoutId}:cancel`,
      type: "PAYOUT_CANCEL",
      entries: [
        { accountId: SYS.PAYOUT_HOLD, amount: -p.coins },
        { accountId: walletAccountId(p.creator_id), amount: p.coins },
      ],
    });
    await tx.query("UPDATE payouts SET status='CANCELLED' WHERE id=$1", [payoutId]);
  });
}

/**
 * 보류 기간이 끝난 출금을 정산하는 배치.
 * 외부 호출(오프램프)은 DB 트랜잭션 밖에서 하고, 성공 후 코인을 소각(PAYOUT_HOLD -> ISSUANCE)한다.
 * 호출 후 소각 전에 장애가 나도 다음 실행에서 같은 키로 재호출하므로 중복 지급은 오프램프의 멱등성에 의존한다.
 */
export async function settleDuePayouts(ctx: Ctx, offramp: OffRamp, now = new Date()) {
  const due = await ctx.db.query<any>(
    "SELECT * FROM payouts WHERE status = 'PENDING' AND release_at <= $1 ORDER BY release_at, id",
    [now],
  );
  const summary = { paid: 0, retry: 0, failed: 0 };
  for (const p of due) {
    try {
      const { externalId } = await offramp.pay({
        idempotencyKey: `payout:${p.id}`,
        currency: p.currency,
        amountMinor: p.amount_minor,
        creatorId: p.creator_id,
      });
      await ctx.db.transaction(async (tx) => {
        await post(tx, {
          idempotencyKey: `payout:${p.id}:settle`,
          type: "PAYOUT_SETTLE",
          entries: [
            { accountId: SYS.PAYOUT_HOLD, amount: -p.coins },
            { accountId: SYS.ISSUANCE, amount: p.coins },
          ],
          memo: { payoutId: p.id, externalId },
        });
        await tx.query("UPDATE payouts SET status='PAID', external_id=$1, settled_at=$2 WHERE id=$3", [externalId, now, p.id]);
      });
      summary.paid++;
    } catch (e: any) {
      const attempts = p.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      await ctx.db.query("UPDATE payouts SET attempts=$1, last_error=$2, status=$3 WHERE id=$4", [
        attempts,
        String(e?.message ?? e),
        failed ? "FAILED" : "PENDING",
        p.id,
      ]);
      failed ? summary.failed++ : summary.retry++;
    }
  }
  return summary;
}
