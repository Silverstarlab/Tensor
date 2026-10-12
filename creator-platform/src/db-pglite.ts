import type { Db } from "./db.js";

/** 개발/테스트용 어댑터. PGlite = WASM으로 컴파일된 실제 PostgreSQL. 운영 의존성이 아니므로 동적으로 불러온다. */
// 파라미터 없는 SQL은 여러 문장일 수 있으므로 exec로 실행한다(마이그레이션용). PostgreSQL의 단순 쿼리 프로토콜과 같은 동작.
async function run(c: any, sql: string, params?: unknown[]): Promise<any[]> {
  if (!params || params.length === 0) {
    const r = await c.exec(sql);
    return (r[r.length - 1]?.rows ?? []) as any[];
  }
  return (await c.query(sql, params)).rows as any[];
}

export async function openPgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite(dataDir);
  return {
    async query(sql, params) {
      return run(pg, sql, params);
    },
    async transaction(fn) {
      return pg.transaction(async (t) => fn({ query: (sql, params) => run(t, sql, params) }));
    },
    async close() {
      await pg.close();
    },
  };
}
