import type { Db } from "./db.js";
import { SCHEMA_SQL } from "./schema.js";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * 한 번 배포된 마이그레이션은 절대 수정하지 않는다. 변경은 새 버전을 추가한다.
 */
export const MIGRATIONS: Migration[] = [
  { version: 1, name: "initial_schema", sql: SCHEMA_SQL },
  { version: 2, name: "user_password_hash", sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;` },
  {
    version: 3,
    name: "leak_report_analysis",
    sql: `ALTER TABLE leak_reports ADD COLUMN IF NOT EXISTS z_score REAL;
          ALTER TABLE leak_reports ADD COLUMN IF NOT EXISTS detail JSONB;`,
  },
];

const LOCK_KEY = 727_274_001; // 여러 인스턴스가 동시에 시작해도 마이그레이션이 한 번에 하나씩만 돈다

export async function migrate(db: Db): Promise<{ applied: number[] }> {
  await db.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INT PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  );
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    await db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [LOCK_KEY]);
      const done = await tx.query("SELECT 1 FROM schema_migrations WHERE version = $1", [m.version]);
      if (done.length) return;
      await tx.query(m.sql);
      await tx.query("INSERT INTO schema_migrations (version, name) VALUES ($1,$2)", [m.version, m.name]);
      applied.push(m.version);
    });
  }
  return { applied };
}
