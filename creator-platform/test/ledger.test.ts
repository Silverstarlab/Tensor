import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../src/db.js";
import { testDb } from "./helpers.js";
import { post, getBalance, verifyLedger, SYS } from "../src/ledger.js";

async function setup(): Promise<Db> {
  const db = await testDb();
  await db.query("INSERT INTO users(id,email,role,region) VALUES ('u1','u1@x.com','user','KR'),('u2','u2@x.com','user','KR')");
  await db.query(
    "INSERT INTO ledger_accounts(id,kind,owner_user_id,address) VALUES ('w1','USER_WALLET','u1','wlt_1'),('w2','USER_WALLET','u2','wlt_2')",
  );
  return db;
}
const fund = (db: Db, key: string, to: string, n: number) =>
  db.transaction((tx) =>
    post(tx, { idempotencyKey: key, type: "TEST_FUND", entries: [{ accountId: SYS.ISSUANCE, amount: -n }, { accountId: to, amount: n }] }),
  );

test("균형 잡힌 거래만 허용한다", async () => {
  const db = await setup();
  await assert.rejects(
    db.transaction((tx) =>
      post(tx, { idempotencyKey: "k1", type: "T", entries: [{ accountId: "w1", amount: 5 }, { accountId: "w2", amount: -4 }] }),
    ),
    { code: "unbalanced" },
  );
  await assert.rejects(
    db.transaction((tx) => post(tx, { idempotencyKey: "k2", type: "T", entries: [{ accountId: "w1", amount: 0 }] })),
    { code: "invalid_entries" },
  );
  await assert.rejects(
    db.transaction((tx) =>
      post(tx, { idempotencyKey: "k3", type: "T", entries: [{ accountId: "w1", amount: 1.5 }, { accountId: "w2", amount: -1.5 }] }),
    ),
    { code: "invalid_amount" },
  );
});

test("멱등성: 같은 키는 한 번만 반영되고, 다른 요청이면 충돌", async () => {
  const db = await setup();
  const a = await fund(db, "k", "w1", 100);
  const b = await fund(db, "k", "w1", 100);
  assert.equal(a.replayed, false);
  assert.equal(b.replayed, true);
  assert.equal(a.txId, b.txId);
  assert.equal(await getBalance(db, "w1"), 100);
  await assert.rejects(fund(db, "k", "w1", 999), { code: "idempotency_conflict" });
});

test("잔액 부족이면 거절하고 아무것도 바뀌지 않는다", async () => {
  const db = await setup();
  await fund(db, "f", "w1", 50);
  await assert.rejects(
    db.transaction((tx) =>
      post(tx, { idempotencyKey: "x", type: "T", entries: [{ accountId: "w1", amount: -51 }, { accountId: "w2", amount: 51 }] }),
    ),
    { code: "insufficient_funds" },
  );
  assert.equal(await getBalance(db, "w1"), 50);
  assert.equal(await getBalance(db, "w2"), 0);
});

test("동시 출금 경쟁에서도 이중 지불이 없다", async () => {
  const db = await setup();
  await fund(db, "f", "w1", 100);
  const attempts = Array.from({ length: 8 }, (_, i) =>
    db
      .transaction((tx) =>
        post(tx, { idempotencyKey: `race${i}`, type: "T", entries: [{ accountId: "w1", amount: -30 }, { accountId: "w2", amount: 30 }] }),
      )
      .then(() => "ok", () => "fail"),
  );
  const results = await Promise.all(attempts);
  assert.equal(results.filter((r) => r === "ok").length, 3);
  assert.equal(await getBalance(db, "w1"), 10);
  assert.equal(await getBalance(db, "w2"), 90);
  assert.deepEqual(await verifyLedger(db), { ok: true, problems: [] });
});

test("원장 기록은 수정/삭제할 수 없다", async () => {
  const db = await setup();
  await fund(db, "f", "w1", 10);
  await assert.rejects(db.query("UPDATE ledger_entries SET amount = 999"), /immutable/);
  await assert.rejects(db.query("DELETE FROM ledger_entries"), /immutable/);
  await assert.rejects(db.query("DELETE FROM ledger_transactions"), /immutable/);
});

test("verifyLedger는 잔액 조작을 탐지한다", async () => {
  const db = await setup();
  await fund(db, "f", "w1", 10);
  await db.query("UPDATE ledger_accounts SET balance = balance + 1 WHERE id = 'w1'");
  const r = await verifyLedger(db);
  assert.equal(r.ok, false);
  assert.ok(r.problems.length >= 2);
});
