import { randomBytes } from "node:crypto";
import { openDb, type Db } from "../src/db.js";

/**
 * 기본은 메모리 PGlite. TEST_DATABASE_URL이 있으면 실제 PostgreSQL에서 같은 테스트를 돌린다(테스트마다 별도 스키마).
 */
export async function testDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  return url ? openDb(url, { schema: "t_" + randomBytes(6).toString("hex") }) : openDb();
}
