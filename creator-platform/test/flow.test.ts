import { test } from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { loadConfig } from "../src/config.js";
import type { Ctx } from "../src/context.js";
import { createUser, getWallet, setKycStatus } from "../src/accounts.js";
import { createCharge, confirmCharge } from "../src/charges.js";
import { createPlan, subscribe, cancelSubscription, releaseDue } from "../src/subscriptions.js";
import { createContent, grantAccess, computeWmId, verifyMediaUrl, resolveDeliveryForMedia } from "../src/deliveries.js";
import { reportLeak } from "../src/leaks.js";
import { requestPayout, settleDuePayouts, cancelPayout, MockOffRamp } from "../src/payouts.js";
import { verifyLedger, getBalance, SYS } from "../src/ledger.js";

const T0 = new Date("2026-01-01T00:00:00Z");
const day = (n: number) => new Date(T0.getTime() + n * 86_400_000);

async function world(coins = 1000) {
  const ctx: Ctx = { db: await testDb(), cfg: loadConfig({}) };
  const creator = await createUser(ctx, { email: "c@x.com", role: "creator", region: "KR" });
  const fan = await createUser(ctx, { email: "f@x.com", role: "user", region: "KR" });
  const ch = await createCharge(ctx, fan.userId, coins);
  await confirmCharge(ctx, ch.chargeId, "pg_1", T0);
  const plan = await createPlan(ctx, creator.userId, 300, 30);
  return { ctx, creator, fan, plan };
}
const bal = async (ctx: Ctx, userId: string) => (await getWallet(ctx, userId)).balanceCoins;
const ok = async (ctx: Ctx) => assert.deepEqual(await verifyLedger(ctx.db), { ok: true, problems: [] });

test("충전: 지역 가격표로 금액 계산, 웹훅 중복에도 코인은 한 번만 발행", async () => {
  const ctx: Ctx = { db: await testDb(), cfg: loadConfig({}) };
  const fan = await createUser(ctx, { email: "f@x.com", role: "user", region: "KR" });
  const ch = await createCharge(ctx, fan.userId, 1000);
  assert.deepEqual([ch.currency, ch.amountMinor], ["KRW", 100000]); // 1코인 = 100원
  const a = await confirmCharge(ctx, ch.chargeId, "pg_1");
  const b = await confirmCharge(ctx, ch.chargeId, "pg_1");
  assert.deepEqual([a.replayed, b.replayed], [false, true]);
  assert.equal(await bal(ctx, fan.userId), 1000);
  await assert.rejects(confirmCharge(ctx, ch.chargeId, "pg_OTHER"), { code: "payment_mismatch" });
  const ch2 = await createCharge(ctx, fan.userId, 10);
  await assert.rejects(confirmCharge(ctx, ch2.chargeId, "pg_1"), { code: "payment_reused" });
  assert.equal(await bal(ctx, fan.userId), 1000);
  await assert.rejects(createCharge(ctx, fan.userId, 0), { code: "invalid_coins" });
  await ok(ctx);
});

test("구독: 에스크로 보관 후 일할 정산, 수수료 분리, 만료 처리", async () => {
  const { ctx, creator, fan, plan } = await world();
  await subscribe(ctx, fan.userId, plan.planId, T0);
  assert.equal(await bal(ctx, fan.userId), 700);
  assert.equal(await getBalance(ctx.db, SYS.ESCROW), 300);

  await releaseDue(ctx, day(10));
  await releaseDue(ctx, day(10)); // 재실행해도 중복 정산 없음
  assert.equal(await bal(ctx, creator.userId), 90);
  assert.equal(await getBalance(ctx.db, SYS.REVENUE), 10);
  assert.equal(await getBalance(ctx.db, SYS.ESCROW), 200);
  await ok(ctx);

  await releaseDue(ctx, day(30));
  assert.equal(await bal(ctx, creator.userId), 270);
  assert.equal(await getBalance(ctx.db, SYS.REVENUE), 30);
  assert.equal(await getBalance(ctx.db, SYS.ESCROW), 0);
  const [s] = await ctx.db.query<any>("SELECT status FROM subscriptions");
  assert.equal(s.status, "EXPIRED");
  await ok(ctx);

  // 만료 후 갱신 가능
  await subscribe(ctx, fan.userId, plan.planId, day(31));
  assert.equal(await bal(ctx, fan.userId), 400);
  await ok(ctx);
});

test("구독: 중복 구독 차단, 잔액 부족 거절, 해지 시 일할 환불", async () => {
  const { ctx, creator, fan, plan } = await world(500);
  const sub = await subscribe(ctx, fan.userId, plan.planId, T0);
  await assert.rejects(subscribe(ctx, fan.userId, plan.planId, day(1)), { code: "already_subscribed" });

  const r = await cancelSubscription(ctx, fan.userId, sub.subscriptionId, day(15));
  assert.equal(r.refundedCoins, 150);
  assert.equal(await bal(ctx, fan.userId), 200 + 150);
  assert.equal(await bal(ctx, creator.userId), 135); // 150 - 수수료 15
  await assert.rejects(cancelSubscription(ctx, fan.userId, sub.subscriptionId, day(16)), { code: "not_active" });
  await ok(ctx);

  const poor = await createUser(ctx, { email: "p@x.com", role: "user", region: "KR" });
  await assert.rejects(subscribe(ctx, poor.userId, plan.planId, day(20)), { code: "insufficient_funds" });
  assert.equal((await ctx.db.query("SELECT 1 FROM subscriptions WHERE user_id = $1", [poor.userId])).length, 0); // 롤백 확인
  await ok(ctx);
});

test("열람과 유출 추적: 구독자만 접근, wm_id로 계정 역조회", async () => {
  const { ctx, creator, fan, plan } = await world();
  const { contentId } = await createContent(ctx, creator.userId, { kind: "image", storageKey: "s3://private/a.png" });
  const stranger = await createUser(ctx, { email: "s@x.com", role: "user", region: "KR" });
  await assert.rejects(grantAccess(ctx, fan.userId, contentId, T0), { code: "not_subscribed" });

  const sub = await subscribe(ctx, fan.userId, plan.planId, T0);
  const g1 = await grantAccess(ctx, fan.userId, contentId, day(1));
  const g2 = await grantAccess(ctx, fan.userId, contentId, day(2));
  assert.equal(g1.wmId, computeWmId(ctx.cfg, sub.receiptId, contentId));
  assert.equal(g1.wmId, g2.wmId);
  const [d] = await ctx.db.query<any>("SELECT access_count FROM deliveries");
  assert.equal(d.access_count, 2);

  // 구독자마다 다른 wm_id
  const fan2 = await createUser(ctx, { email: "f2@x.com", role: "user", region: "KR" });
  const c2 = await createCharge(ctx, fan2.userId, 500);
  await confirmCharge(ctx, c2.chargeId, "pg_2", T0);
  await subscribe(ctx, fan2.userId, plan.planId, T0);
  const g3 = await grantAccess(ctx, fan2.userId, contentId, day(1));
  assert.notEqual(g3.wmId, g1.wmId);

  // 서명 URL
  const u = new URL(g1.url);
  const p = { contentId, deliveryId: u.searchParams.get("d")!, exp: Number(u.searchParams.get("exp")), sig: u.searchParams.get("sig")! };
  assert.equal(verifyMediaUrl(ctx.cfg, p, day(1)), true);
  assert.equal(verifyMediaUrl(ctx.cfg, { ...p, sig: p.sig + "x" }, day(1)), false);
  assert.equal(verifyMediaUrl(ctx.cfg, p, new Date(day(1).getTime() + 3_600_000)), false);
  assert.equal((await resolveDeliveryForMedia(ctx, p, day(1))).wmId, g1.wmId);

  // 유출 신고 -> 계정 특정
  const leak = await reportLeak(ctx, { wmId: g1.wmId!, sourceUrl: "https://leak.example/x.png", confidence: 0.97, contentId });
  assert.deepEqual([leak.resolved, leak.userId, leak.receiptId, leak.creatorId, leak.contentMatches], [true, fan.userId, sub.receiptId, creator.userId, true]);
  const unknown = await reportLeak(ctx, { wmId: "0123456789abcdef", sourceUrl: "https://leak.example/y.png", confidence: 0.4 });
  assert.equal(unknown.resolved, false);
  await assert.rejects(reportLeak(ctx, { wmId: "zz", sourceUrl: "u", confidence: 0.5 }), { code: "invalid_wm_id" });

  // 크리에이터 미리보기는 워터마크/전달 기록 없음, 만료 후에는 접근 불가
  const own = await grantAccess(ctx, creator.userId, contentId, day(1));
  assert.deepEqual([own.owner, own.wmId], [true, null]);
  await assert.rejects(grantAccess(ctx, fan.userId, contentId, day(31)), { code: "not_subscribed" });
  void stranger;
  await ok(ctx);
});

test("출금: KYC 필수, 보류 기간 후 정산, 실패 재시도, 취소 복구", async () => {
  const { ctx, creator, fan, plan } = await world();
  await subscribe(ctx, fan.userId, plan.planId, T0);
  await releaseDue(ctx, day(30)); // 크리에이터 270코인
  const off = new MockOffRamp();

  await assert.rejects(requestPayout(ctx, creator.userId, 200, day(31)), { code: "kyc_required" });
  await setKycStatus(ctx, creator.userId, "VERIFIED");
  await assert.rejects(requestPayout(ctx, creator.userId, 50, day(31)), { code: "below_minimum" });
  await assert.rejects(requestPayout(ctx, creator.userId, 271, day(31)), { code: "insufficient_funds" });

  const p = await requestPayout(ctx, creator.userId, 200, day(31));
  assert.deepEqual([p.currency, p.amountMinor], ["KRW", 20000]); // 200코인 = 20,000원
  assert.equal(await bal(ctx, creator.userId), 70);
  assert.equal(await getBalance(ctx.db, SYS.PAYOUT_HOLD), 200);

  assert.deepEqual(await settleDuePayouts(ctx, off, day(35)), { paid: 0, retry: 0, failed: 0 }); // 보류 중
  off.failNext = 1;
  assert.deepEqual(await settleDuePayouts(ctx, off, day(39)), { paid: 0, retry: 1, failed: 0 });
  assert.deepEqual(await settleDuePayouts(ctx, off, day(40)), { paid: 1, retry: 0, failed: 0 });
  assert.deepEqual(await settleDuePayouts(ctx, off, day(41)), { paid: 0, retry: 0, failed: 0 }); // 중복 지급 없음
  assert.equal(off.calls.length, 1);
  assert.deepEqual([off.calls[0]!.currency, off.calls[0]!.amountMinor], ["KRW", 20000]);
  assert.equal(await getBalance(ctx.db, SYS.PAYOUT_HOLD), 0);
  await ok(ctx);

  await assert.rejects(requestPayout(ctx, creator.userId, 70, day(41)), { code: "below_minimum" }); // 잔여 70 < 최소 100
  ctx.cfg.minPayoutCoins = 50;
  const p2 = await requestPayout(ctx, creator.userId, 70, day(41));
  await cancelPayout(ctx, p2.payoutId);
  assert.equal(await bal(ctx, creator.userId), 70);
  await assert.rejects(cancelPayout(ctx, p2.payoutId), { code: "not_pending" });
  await ok(ctx);
});

test("동시성: 결제 웹훅 중복/동시 구독 요청에도 한 번만 반영", async () => {
  const ctx: Ctx = { db: await testDb(), cfg: loadConfig({}) };
  const creator = await createUser(ctx, { email: "c@x.com", role: "creator", region: "KR" });
  const fan = await createUser(ctx, { email: "f@x.com", role: "user", region: "KR" });
  const ch = await createCharge(ctx, fan.userId, 1000);
  const hooks = await Promise.all(Array.from({ length: 6 }, () => confirmCharge(ctx, ch.chargeId, "pg_dup", T0)));
  assert.equal(hooks.filter((h) => !h.replayed).length, 1);
  assert.equal(await bal(ctx, fan.userId), 1000);

  const plan = await createPlan(ctx, creator.userId, 300, 30);
  const subs = await Promise.all(
    Array.from({ length: 5 }, () => subscribe(ctx, fan.userId, plan.planId, T0).then(() => "ok", (e) => e.code)),
  );
  assert.equal(subs.filter((r) => r === "ok").length, 1);
  assert.ok(subs.filter((r) => r !== "ok").every((r) => r === "already_subscribed"), JSON.stringify(subs));
  assert.equal(await bal(ctx, fan.userId), 700);
  await ok(ctx);
});
