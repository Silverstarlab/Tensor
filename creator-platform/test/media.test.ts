import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { MockOffRamp } from "../src/payouts.js";
import { MemoryStorage, isSafeKey, LocalFsStorage } from "../src/storage.js";
import type { AnalysisResult, WatermarkEngine } from "../src/watermark.js";
import { WatermarkError } from "../src/watermark.js";
import { testDb } from "./helpers.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 7)]);
const PW = "correct horse battery";

/** 결정적인 가짜 엔진: 파일 끝에 wm_id를 붙이고, 끝에서 읽어 후보와 대조한다 */
class FakeEngine implements WatermarkEngine {
  embedCalls = 0;
  fail: "none" | "unavailable" = "none";
  async embed(input: Buffer, wmId: string) {
    this.embedCalls++;
    if (this.fail === "unavailable") throw new WatermarkError("unavailable", "down");
    return { data: Buffer.concat([input, Buffer.from("|WM:" + wmId)]), contentType: "image/jpeg" };
  }
  async analyze(input: Buffer, candidates: string[]): Promise<AnalysisResult> {
    const s = input.toString("latin1");
    const i = s.lastIndexOf("|WM:");
    const id = i < 0 ? null : s.slice(i + 4, i + 20);
    const hit = id !== null && candidates.includes(id);
    return { detected: hit, wmId: hit ? id : null, z: hit ? 10.1 : 2.0, threshold: 6.5, pValue: hit ? 1e-12 : 0.9, nCandidates: candidates.length };
  }
}

async function harness(engine: WatermarkEngine | null = new FakeEngine()) {
  const cfg = loadConfig({});
  const storage = new MemoryStorage();
  const app = await buildApp({ db: await testDb(), cfg }, new MockOffRamp(), { storage, engine });
  const call = async (method: any, url: string, o: { token?: string; admin?: boolean; hook?: boolean; body?: any; raw?: Buffer } = {}) => {
    const headers: Record<string, string> = {};
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.admin) headers["x-admin-key"] = cfg.adminKey;
    if (o.hook) headers["x-webhook-secret"] = cfg.webhookSecret;
    if (o.raw) headers["content-type"] = "image/png";
    const r = await app.inject({ method, url, headers, payload: o.raw ?? o.body });
    let json: any = null;
    try { json = JSON.parse(r.body); } catch { /* binary */ }
    return { status: r.statusCode, json, body: r.rawPayload, headers: r.headers };
  };
  const signup = async (email: string, role: string) => (await call("POST", "/auth/signup", { body: { email, password: PW, role, region: "KR" } })).json;
  // 크리에이터(콘텐츠 1개 업로드) + 구독자(충전 후 구독) 준비
  const setup = async () => {
    const creator = await signup("c@x.com", "creator");
    const fan = await signup("f@x.com", "user");
    const content = (await call("POST", "/contents/upload", { token: creator.token, raw: PNG })).json.contentId;
    const plan = (await call("POST", "/plans", { token: creator.token, body: { priceCoins: 300, periodDays: 30 } })).json.planId;
    const ch = (await call("POST", "/charges", { token: fan.token, body: { coins: 1000 } })).json;
    await call("POST", "/webhooks/pg/confirm", { hook: true, body: { chargeId: ch.chargeId, pgPaymentId: "p1" } });
    await call("POST", "/subscriptions", { token: fan.token, body: { planId: plan } });
    return { creator, fan, content, plan };
  };
  const pathOf = (url: string) => { const u = new URL(url); return u.pathname + u.search; };
  return { call, signup, setup, pathOf, engine: engine as FakeEngine | null, storage, cfg };
}

test("저장소 키 검증: 경로 탈출과 이상한 문자를 막는다", async () => {
  for (const bad of ["../etc/passwd", "/abs/path", "a/../b", "a//b", ".hidden", "a b", "a\\b", "", "x".repeat(300), "a/./b"])
    assert.equal(isSafeKey(bad), false, JSON.stringify(bad));
  for (const good of ["originals/abc.png", "wm/0123456789abcdef.jpg", "a-b_c.d/e"]) assert.equal(isSafeKey(good), true, good);
  const fs = new LocalFsStorage("/tmp/wm-storage-test");
  await assert.rejects(fs.get("../outside"), /unsafe/);
  await fs.put("a/b.txt", Buffer.from("hi"));
  assert.equal((await fs.get("a/b.txt"))!.toString(), "hi");
  assert.equal(await fs.get("a/none.txt"), null);
});

test("업로드 검증: 크리에이터만, 이미지 형식만, 위험한 storageKey 거부", async () => {
  const h = await harness();
  const creator = await h.signup("c@x.com", "creator");
  const fan = await h.signup("f@x.com", "user");
  assert.equal((await h.call("POST", "/contents/upload", { token: fan.token, raw: PNG })).status, 403);
  assert.equal((await h.call("POST", "/contents/upload", { token: creator.token, raw: Buffer.from("not an image at all, just text") })).status, 415);
  assert.equal((await h.call("POST", "/contents/upload")).status, 401);
  const ok = await h.call("POST", "/contents/upload", { token: creator.token, raw: PNG });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.format, "png");
  for (const k of ["../../etc/passwd", "/etc/passwd", "a/../b"])
    assert.equal((await h.call("POST", "/contents", { token: creator.token, body: { kind: "image", storageKey: k } })).status, 400, k);
});

test("미디어 전달: 구독자별 워터마크 삽입, 서명 검증, 캐시, 본인 미리보기는 원본", async () => {
  const h = await harness();
  const { creator, fan, content } = await h.setup();
  const access = await h.call("GET", `/contents/${content}/access`, { token: fan.token });
  const path = h.pathOf(access.json.url);

  const r1 = await h.call("GET", path);
  assert.equal(r1.status, 200);
  assert.equal(r1.headers["cache-control"], "private, no-store");
  assert.ok(r1.body.subarray(0, PNG.length).equals(PNG));
  assert.match(r1.body.subarray(PNG.length).toString(), /^\|WM:[0-9a-f]{16}$/);

  assert.equal((await h.call("GET", path)).status, 200);
  assert.equal(h.engine!.embedCalls, 1); // 두 번째는 캐시

  // 서명 위조/변조
  assert.equal((await h.call("GET", path.replace(/sig=./, "sig=X"))).status, 403);
  assert.equal((await h.call("GET", path.replace(/exp=\d+/, "exp=9999999999"))).status, 403);
  assert.equal((await h.call("GET", path.replace(/d=[^&]+/, "d=owner"))).status, 403);

  // 크리에이터 본인 미리보기: 워터마크 없음
  const own = await h.call("GET", `/contents/${content}/access`, { token: creator.token });
  const orig = await h.call("GET", h.pathOf(own.json.url));
  assert.equal(orig.status, 200);
  assert.ok(orig.body.equals(PNG));
});

test("fail closed: 엔진이 없거나 장애면 워터마크 없는 원본을 내보내지 않는다", async () => {
  for (const mode of ["no-engine", "engine-down"] as const) {
    const h = await harness(mode === "no-engine" ? null : new FakeEngine());
    const { fan, content } = await h.setup();
    if (mode === "engine-down") h.engine!.fail = "unavailable";
    const access = await h.call("GET", `/contents/${content}/access`, { token: fan.token });
    const r = await h.call("GET", h.pathOf(access.json.url));
    assert.equal(r.status, 503, mode);
    assert.equal(r.json.error, "watermark_engine_unavailable");
    assert.ok(!r.body.equals(PNG));
  }
});

test("유출 분석: 전달본에서 구독자를 특정하고, 무관한 이미지는 판정하지 않는다", async () => {
  const h = await harness();
  const { fan, content } = await h.setup();
  const access = await h.call("GET", `/contents/${content}/access`, { token: fan.token });
  const delivered = (await h.call("GET", h.pathOf(access.json.url))).body;

  const url = `/admin/leaks/analyze?sourceUrl=${encodeURIComponent("https://leak.example/p.jpg")}&contentId=${content}`;
  assert.equal((await h.call("POST", url, { raw: delivered })).status, 401);
  const hit = await h.call("POST", url, { admin: true, raw: delivered });
  assert.equal(hit.status, 200);
  assert.deepEqual([hit.json.detected, hit.json.resolved, hit.json.userId], [true, true, fan.userId]);
  assert.ok(hit.json.z > hit.json.threshold);

  const miss = await h.call("POST", url, { admin: true, raw: PNG });
  assert.deepEqual([miss.status, miss.json.detected], [200, false]);
  assert.equal((await h.call("POST", url, { admin: true, raw: Buffer.from("plain text, not an image") })).status, 415);
  assert.equal((await h.call("POST", "/admin/leaks/analyze", { admin: true, raw: delivered })).status, 400); // sourceUrl 필수

});

test("유출 분석: 후보가 없으면 판정하지 않고 사유를 알려준다", async () => {
  const h = await harness();
  const creator = await h.signup("c@x.com", "creator");
  const content = (await h.call("POST", "/contents/upload", { token: creator.token, raw: PNG })).json.contentId;
  const r = await h.call("POST", `/admin/leaks/analyze?sourceUrl=u&contentId=${content}`, { admin: true, raw: PNG });
  assert.deepEqual([r.json.detected, r.json.reason], [false, "no_candidates"]);
});
