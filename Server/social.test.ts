import { test } from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { loadConfig } from "../src/config.js";
import type { Ctx } from "../src/context.js";
import { createUser, getWallet } from "../src/accounts.js";
import { createCharge, confirmCharge } from "../src/charges.js";
import { createPlan, subscribe, cancelSubscription } from "../src/subscriptions.js";
import { createContent, grantAccess } from "../src/deliveries.js";
import { setFollow, createPost, purchasePpv, listPosts, creatorProfile } from "../src/social.js";
import { verifyLedger } from "../src/ledger.js";

async function world() {
  const ctx: Ctx = { db: await testDb(), cfg: loadConfig({}) };
  const creator = await createUser(ctx, { email: "c@x.com", role: "creator", region: "KR" });
  const fan = await createUser(ctx, { email: "f@x.com", role: "user", region: "KR" });
  await confirmCharge(ctx, (await createCharge(ctx, fan.userId, 2000)).chargeId, "pg_1");
  const plan = await createPlan(ctx, creator.userId, 200, 30, 1000); // 첫 달 10% 할인
  const img = await createContent(ctx, creator.userId, { kind: "image", storageKey: "originals/a.png" });
  return { ctx, creator, fan, plan, img };
}
const bal = async (c: Ctx, u: string) => (await getWallet(c, u)).balanceCoins;

test("첫 달 할인은 처음 구독에만 적용되고 원장 불변식이 유지된다", async () => {
  const { ctx, creator, fan, plan } = await world();
  const p0 = await creatorProfile(ctx, fan.userId, creator.userId);
  assert.equal(p0.plan?.firstMonthPriceCoins, 180);
  const s1 = await subscribe(ctx, fan.userId, plan.planId);
  assert.equal(s1.priceCoins, 180);
  assert.equal(await bal(ctx, fan.userId), 1820);
  await cancelSubscription(ctx, fan.userId, s1.subscriptionId);
  const s2 = await subscribe(ctx, fan.userId, plan.planId);
  assert.equal(s2.priceCoins, 200); // 재구독은 정가
  assert.equal((await creatorProfile(ctx, fan.userId, creator.userId)).plan?.firstMonthPriceCoins, null);
  assert.deepEqual(await verifyLedger(ctx.db), { ok: true, problems: [] });
});

test("PPV: 구독만으로는 열람 불가, 구매 후 열람, 대금은 수수료 분리, 중복 구매 거부", async () => {
  const { ctx, creator, fan, plan, img } = await world();
  await subscribe(ctx, fan.userId, plan.planId);
  const { postId } = await createPost(ctx, creator.userId, { body: "유료", visibility: "PPV", ppvPriceCoins: 100, contentId: img.contentId });
  await assert.rejects(grantAccess(ctx, fan.userId, img.contentId), { code: "ppv_required" });
  const locked = (await listPosts(ctx, fan.userId, { creatorId: creator.userId, visibility: "PPV" }))[0]!;
  assert.deepEqual([locked.locked, locked.body, locked.contentId], [true, null, null]);
  const before = await bal(ctx, fan.userId);
  await purchasePpv(ctx, fan.userId, postId);
  assert.equal(await bal(ctx, fan.userId), before - 100);
  assert.equal(await bal(ctx, creator.userId), 90); // 수수료 10%
  await assert.rejects(purchasePpv(ctx, fan.userId, postId), { code: "already_purchased" });
  const g = await grantAccess(ctx, fan.userId, img.contentId);
  assert.equal(g.owner, false);
  assert.ok(g.wmId); // 구매 영수증 기반 wm_id로 추적 가능
  assert.equal((await listPosts(ctx, fan.userId, { creatorId: creator.userId, visibility: "PPV" }))[0]!.locked, false);
  assert.deepEqual(await verifyLedger(ctx.db), { ok: true, problems: [] });
});

test("게시글: 구독 글은 비구독자에게 마스킹, 무료 글에는 이미지 불가, 팔로우 피드", async () => {
  const { ctx, creator, fan, plan, img } = await world();
  await createPost(ctx, creator.userId, { body: "공지", visibility: "FREE", category: "공지" });
  await createPost(ctx, creator.userId, { body: "멤버 전용", visibility: "SUB", contentId: img.contentId });
  await assert.rejects(createPost(ctx, creator.userId, { body: "x", visibility: "FREE", contentId: img.contentId }), { code: "free_media_not_allowed" });
  await assert.rejects(createPost(ctx, creator.userId, { body: "x", visibility: "PPV", ppvPriceCoins: 10 }), { code: "ppv_needs_content" });
  const guest = await listPosts(ctx, null, { creatorId: creator.userId, visibility: "FEED" });
  assert.deepEqual(guest.map((p) => [p.visibility, p.locked]).sort(), [["FREE", false], ["SUB", true]]);
  assert.equal(guest.find((p) => p.visibility === "SUB")!.body, null);
  await setFollow(ctx, fan.userId, creator.userId, true);
  assert.equal((await listPosts(ctx, fan.userId, { feedOf: fan.userId, visibility: "FEED" })).length, 2);
  assert.equal((await creatorProfile(ctx, null, creator.userId)).followers, 1);
  await subscribe(ctx, fan.userId, plan.planId);
  assert.equal((await listPosts(ctx, fan.userId, { creatorId: creator.userId, visibility: "FEED" })).every((p) => !p.locked), true);
});
