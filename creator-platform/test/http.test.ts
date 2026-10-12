import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { MockOffRamp } from "../src/payouts.js";
import { issueToken } from "../src/auth.js";
import { testDb } from "./helpers.js";

async function harness() {
  const cfg = loadConfig({});
  const app = await buildApp({ db: await testDb(), cfg }, new MockOffRamp());
  const call = async (method: any, url: string, opts: { token?: string; admin?: boolean; hook?: boolean; body?: any; raw?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.admin) headers["x-admin-key"] = cfg.adminKey;
    if (opts.hook) headers["x-webhook-secret"] = cfg.webhookSecret;
    if (opts.raw) headers["content-type"] = "application/json";
    const r = await app.inject({ method, url, headers, payload: opts.raw ?? opts.body });
    return { status: r.statusCode, json: (r.body ? safe(r.body) : null) as any, headers: r.headers };
  };
  return { cfg, app, call };
}
const safe = (b: string) => { try { return JSON.parse(b); } catch { return b; } };
const PW = "correct horse battery";

test("HTTP: 가입/로그인 -> 충전 -> 구독 -> 열람 -> 유출 추적 전체 흐름", async () => {
  const { call } = await harness();
  const c = (await call("POST", "/auth/signup", { body: { email: "c@x.com", password: PW, role: "creator", region: "KR" } })).json;
  const f = (await call("POST", "/auth/signup", { body: { email: "f@x.com", password: PW, role: "user", region: "KR" } })).json;
  assert.equal((await call("POST", "/auth/signup", { body: { email: "c@x.com", password: PW, role: "creator", region: "KR" } })).status, 409);

  const ch = (await call("POST", "/charges", { token: f.token, body: { coins: 1000 } })).json;
  assert.equal((await call("POST", "/webhooks/pg/confirm", { body: { chargeId: ch.chargeId, pgPaymentId: "p1" } })).status, 401);
  assert.equal((await call("POST", "/webhooks/pg/confirm", { hook: true, body: { chargeId: ch.chargeId, pgPaymentId: "p1" } })).status, 200);
  assert.equal((await call("GET", "/me/wallet", { token: f.token })).json.balanceCoins, 1000);

  const plan = (await call("POST", "/plans", { token: c.token, body: { priceCoins: 300, periodDays: 30 } })).json.planId;
  const content = (await call("POST", "/contents", { token: c.token, body: { kind: "image", storageKey: "originals/a.png" } })).json.contentId;
  assert.equal((await call("GET", `/contents/${content}/access`, { token: f.token })).status, 403);

  assert.equal((await call("POST", "/subscriptions", { token: f.token, body: { planId: plan } })).status, 200);
  const access = await call("GET", `/contents/${content}/access`, { token: f.token });
  assert.equal(access.status, 200);
  assert.equal("wmId" in access.json, false); // 클라이언트에는 wm_id가 노출되지 않음

  const u = new URL(access.json.url);
  const resolved = await call("POST", "/internal/media/resolve", {
    admin: true,
    body: { contentId: content, deliveryId: u.searchParams.get("d"), exp: Number(u.searchParams.get("exp")), sig: u.searchParams.get("sig") },
  });
  const leak = await call("POST", "/admin/leaks", { admin: true, body: { wmId: resolved.json.wmId, sourceUrl: "https://leak.example/a.png", confidence: 0.95, contentId: content } });
  assert.deepEqual([leak.json.resolved, leak.json.userId], [true, f.userId]);

  assert.equal((await call("GET", "/admin/ledger/verify")).status, 401);
  assert.deepEqual((await call("GET", "/admin/ledger/verify", { admin: true })).json, { ok: true, problems: [] });
});

test("인증: 로그인, 잘못된 비밀번호, 약한 비밀번호, 위조/만료 토큰", async () => {
  const { call, cfg } = await harness();
  const s = (await call("POST", "/auth/signup", { body: { email: "A@x.com", password: PW, role: "user", region: "KR" } })).json;
  assert.equal((await call("POST", "/auth/signup", { body: { email: "w@x.com", password: "short", role: "user", region: "KR" } })).json.error, "weak_password");

  const ok = await call("POST", "/auth/login", { body: { email: "a@x.com", password: PW } }); // 대소문자 무관
  assert.equal(ok.status, 200);
  assert.equal(ok.json.userId, s.userId);
  assert.equal((await call("POST", "/auth/login", { body: { email: "a@x.com", password: "wrong password!!" } })).status, 401);
  assert.equal((await call("POST", "/auth/login", { body: { email: "nobody@x.com", password: PW } })).status, 401);

  assert.equal((await call("GET", "/me/wallet")).status, 401);
  assert.equal((await call("GET", "/me/wallet", { token: ok.json.token + "x" })).status, 401); // 서명 위조
  assert.equal((await call("GET", "/me/wallet", { token: "not.a.jwt" })).status, 401);
  const expired = await issueToken({ ...cfg, jwtTtlSec: -10 }, s.userId, "user");
  assert.equal((await call("GET", "/me/wallet", { token: expired })).status, 401);
  const otherKey = await issueToken({ ...cfg, jwtSecret: "another-secret-another-secret-12345" }, s.userId, "user");
  assert.equal((await call("GET", "/me/wallet", { token: otherKey })).status, 401);
});

test("운영 엔드포인트와 보안 설정: /ready, 보안 헤더, 본문 크기 제한, 로그인 레이트 리밋", async () => {
  const { call } = await harness();
  assert.equal((await call("GET", "/health")).status, 200);
  const ready = await call("GET", "/ready");
  assert.equal(ready.status, 200);
  assert.equal(ready.headers["x-content-type-options"], "nosniff");
  assert.ok(ready.headers["content-security-policy"]);

  const big = JSON.stringify({ email: "x@x.com", password: "a".repeat(200_000) });
  assert.equal((await call("POST", "/auth/login", { raw: big })).status, 413);

  let last = 0;
  for (let i = 0; i < 12; i++) last = (await call("POST", "/auth/login", { body: { email: "x@x.com", password: "whatever-password" } })).status;
  assert.equal(last, 429);
});
