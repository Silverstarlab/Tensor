import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { MockOffRamp } from "../src/payouts.js";
import { LocalFsStorage } from "../src/storage.js";
import { HttpWatermarkEngine } from "../src/watermark.js";
import { testDb } from "./helpers.js";

/**
 * 실제 파이썬 워터마크 워커를 띄워 백엔드와 끝까지 연결해 본다.
 * 파이썬/의존성이 없으면 건너뛴다(CI에서는 pip install -r worker/requirements.txt 후 실행).
 */
const hasPython = spawnSync("python3", ["-c", "import numpy, scipy, PIL, fastapi, uvicorn"], { stdio: "ignore" }).status === 0;
const KEY = "test-worker-key-0123456789abcdef-0123456789";
const PW = "correct horse battery";

const freePort = () =>
  new Promise<number>((res) => {
    const s = createServer().listen(0, () => {
      const p = (s.address() as any).port;
      s.close(() => res(p));
    });
  });

async function startWorker(): Promise<{ proc: ChildProcess; url: string }> {
  const port = await freePort();
  const proc = spawn("python3", ["-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", String(port), "--log-level", "warning"], {
    cwd: join(process.cwd(), "worker"),
    env: { ...process.env, WORKER_API_KEY: KEY, WM_KEY: "11".repeat(32) },
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url + "/health")).ok) return { proc, url };
    } catch { /* 아직 시작 중 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill();
  throw new Error("worker did not start");
}

test("실제 워터마크 워커 연동: 업로드 -> 구독자별 전달 -> 유출 분석으로 구독자 특정", { skip: !hasPython && "python deps not installed", timeout: 180_000 }, async (t) => {
  const { proc, url } = await startWorker();
  t.after(() => proc.kill());

  const cfg = loadConfig({});
  const storage = new LocalFsStorage(mkdtempSync(join(tmpdir(), "wm-int-")));
  const engine = new HttpWatermarkEngine(url, KEY);
  const app = await buildApp({ db: await testDb(), cfg }, new MockOffRamp(), { storage, engine });
  const call = async (method: any, u: string, o: { token?: string; admin?: boolean; hook?: boolean; body?: any; raw?: Buffer } = {}) => {
    const headers: Record<string, string> = {};
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.admin) headers["x-admin-key"] = cfg.adminKey;
    if (o.hook) headers["x-webhook-secret"] = cfg.webhookSecret;
    if (o.raw) headers["content-type"] = "image/jpeg";
    const r = await app.inject({ method, url: u, headers, payload: o.raw ?? o.body });
    let json: any = null;
    try { json = JSON.parse(r.body); } catch { /* binary */ }
    return { status: r.statusCode, json, body: r.rawPayload };
  };
  const signup = async (email: string, role: string) => (await call("POST", "/auth/signup", { body: { email, password: PW, role, region: "KR" } })).json;

  const original = readFileSync("test/fixtures/photo.jpg");
  const creator = await signup("c@x.com", "creator");
  const content = (await call("POST", "/contents/upload", { token: creator.token, raw: original })).json.contentId;
  const plan = (await call("POST", "/plans", { token: creator.token, body: { priceCoins: 300, periodDays: 30 } })).json.planId;

  const fans: Array<{ userId: string; delivered: Buffer }> = [];
  for (const n of [1, 2]) {
    const fan = await signup(`fan${n}@x.com`, "user");
    const ch = (await call("POST", "/charges", { token: fan.token, body: { coins: 1000 } })).json;
    await call("POST", "/webhooks/pg/confirm", { hook: true, body: { chargeId: ch.chargeId, pgPaymentId: `pg${n}` } });
    await call("POST", "/subscriptions", { token: fan.token, body: { planId: plan } });
    const access = (await call("GET", `/contents/${content}/access`, { token: fan.token })).json;
    const u = new URL(access.url);
    const media = await call("GET", u.pathname + u.search);
    assert.equal(media.status, 200);
    fans.push({ userId: fan.userId, delivered: media.body });
  }
  assert.ok(!fans[0]!.delivered.equals(original), "전달본은 원본과 달라야 한다");
  assert.ok(!fans[0]!.delivered.equals(fans[1]!.delivered), "구독자마다 전달본이 달라야 한다");

  const analyze = (img: Buffer) =>
    call("POST", `/admin/leaks/analyze?sourceUrl=${encodeURIComponent("https://leak.example/x.jpg")}&contentId=${content}`, { admin: true, raw: img });

  for (const f of fans) {
    const r = await analyze(f.delivered);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.detected, r.json.userId], [true, f.userId], "각 전달본은 올바른 구독자로 특정되어야 한다(서로 바뀌면 안 됨)");
    assert.ok(r.json.z > r.json.threshold);
  }
  // 워터마크가 없는 원본은 판정되지 않는다
  const none = await analyze(original);
  assert.equal(none.status, 200);
  assert.equal(none.json.detected, false);
});
