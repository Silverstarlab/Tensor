import pg from "pg";
import type { Db } from "./db.js";

// BIGINT(int8)는 기본적으로 문자열로 오므로 안전한 정수 범위에서 number로 변환한다.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`bigint out of safe integer range: ${v}`);
  return n;
});

const RETRYABLE = new Set(["40001", "40P01"]); // serialization_failure, deadlock_detected
const MAX_TX_ATTEMPTS = 4;

export async function openPgDb(url: string, schema?: string): Promise<Db> {
  if (schema) {
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("invalid schema name");
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    await c.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await c.end();
  }
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  });
  pool.on("error", (e) => console.error("pg pool error", e.message)); // 유휴 연결 오류로 프로세스가 죽지 않게 한다

  return {
    async query(sql, params) {
      return (await pool.query(sql, params as any[])).rows as any[];
    },
    /** 데드락/직렬화 실패는 트랜잭션 전체를 새로 시작해 재시도한다. 콜백은 DB 외 부수효과가 없어야 한다. */
    async transaction(fn) {
      for (let attempt = 1; ; attempt++) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await fn({ query: async (sql, params) => (await client.query(sql, params as any[])).rows as any[] });
          await client.query("COMMIT");
          return result;
        } catch (e: any) {
          await client.query("ROLLBACK").catch(() => {});
          if (RETRYABLE.has(e?.code) && attempt < MAX_TX_ATTEMPTS) continue;
          throw e;
        } finally {
          client.release();
        }
      }
    },
    async close() {
      await pool.end();
    },
  };
}
