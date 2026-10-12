import { test } from "node:test";
import assert from "node:assert/strict";
import { MIGRATIONS, migrate } from "../src/migrations.js";
import { hashPassword, verifyPassword } from "../src/auth.js";
import { testDb } from "./helpers.js";

test("마이그레이션: 재실행해도 안전하고 이력이 남는다", async () => {
  const db = await testDb(); // openDb가 이미 한 번 적용함
  assert.deepEqual((await migrate(db)).applied, []);
  const rows = await db.query<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version");
  assert.deepEqual(rows.map((r) => r.version), MIGRATIONS.map((m) => m.version));
  // 동시에 여러 인스턴스가 시작해도 중복 적용되지 않는다
  await Promise.all([migrate(db), migrate(db), migrate(db)]);
  assert.equal((await db.query("SELECT 1 FROM schema_migrations")).length, MIGRATIONS.length);
});

test("비밀번호 해시: 솔트가 달라지고 검증은 정확하다", async () => {
  const a = await hashPassword("correct horse battery");
  const b = await hashPassword("correct horse battery");
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("correct horse battery", a), true);
  assert.equal(await verifyPassword("correct horse batterz", a), false);
  assert.equal(await verifyPassword("x", "garbage"), false);
});
