import { randomUUID } from "node:crypto";
import type { Ctx } from "./context.js";
import { getUser, walletAccountId } from "./accounts.js";
import { badRequest, conflict, notFound } from "./errors.js";
import { post, SYS } from "./ledger.js";
import { priceFor } from "./pricing.js";

/** 코인 N개 충전 요청. 코인 수를 기준으로 가격을 계산하므로 반올림 오차가 없다. */
export async function createCharge(ctx: Ctx, userId: string, coins: number) {
  if (!Number.isSafeInteger(coins) || coins <= 0 || coins > ctx.cfg.maxChargeCoins)
    throw badRequest("invalid_coins", `coins must be an integer between 1 and ${ctx.cfg.maxChargeCoins}`);
  const user = await getUser(ctx.db, userId);
  const price = priceFor(user.region)!;
  const id = randomUUID();
  const amountMinor = coins * price.minorPerCoin;
  await ctx.db.query(
    "INSERT INTO charges (id,user_id,coins,region,currency,amount_minor,price_version) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [id, userId, coins, user.region, price.currency, amountMinor, price.version],
  );
  return { chargeId: id, coins, currency: price.currency, amountMinor };
}

/**
 * PG 승인 웹훅이 호출한다. 같은 결제가 여러 번 와도 코인은 한 번만 발행된다.
 * 발행 = ISSUANCE(음수) -> 사용자 지갑(양수). 전체 합은 항상 0.
 */
export async function confirmCharge(ctx: Ctx, chargeId: string, pgPaymentId: string, now = new Date()) {
  if (!pgPaymentId) throw badRequest("missing_payment_id", "pgPaymentId is required");
  try {
    return await ctx.db.transaction(async (tx) => {
      const rows = await tx.query<any>("SELECT * FROM charges WHERE id = $1 FOR UPDATE", [chargeId]);
      const c = rows[0];
      if (!c) throw notFound("charge");
      if (c.status === "CONFIRMED") {
        if (c.pg_payment_id !== pgPaymentId) throw conflict("payment_mismatch", "charge confirmed with a different payment");
        return { chargeId, coins: c.coins as number, replayed: true };
      }
      if (c.status !== "PENDING") throw conflict("charge_not_pending", `charge is ${c.status}`);
      await post(tx, {
        idempotencyKey: `charge:${chargeId}`,
        type: "CHARGE",
        entries: [
          { accountId: SYS.ISSUANCE, amount: -c.coins },
          { accountId: walletAccountId(c.user_id), amount: c.coins },
        ],
        memo: { chargeId, pgPaymentId, currency: c.currency, amountMinor: c.amount_minor, priceVersion: c.price_version },
      });
      await tx.query("UPDATE charges SET status='CONFIRMED', pg_payment_id=$1, confirmed_at=$2 WHERE id=$3", [
        pgPaymentId,
        now,
        chargeId,
      ]);
      return { chargeId, coins: c.coins as number, replayed: false };
    });
  } catch (e: any) {
    if (e?.code === "23505" && String(e.message).includes("pg_payment_id"))
      throw conflict("payment_reused", "this payment was already used for another charge");
    throw e;
  }
}
