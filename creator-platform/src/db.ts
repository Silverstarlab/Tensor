import { migrate } from "./migrations.js";

export interface Tx {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
}
export interface Db extends Tx {
  transaction<R>(fn: (tx: Tx) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

export interface OpenDbOptions {
  /** 지정한 스키마를 만들고 search_path로 사용한다 (테스트 격리용). PostgreSQL에서만 의미가 있다. */
  schema?: string;
  /** 마이그레이션 자동 적용 여부 (기본 true) */
  migrate?: boolean;
}

/**
 * DB 열기. url이 있으면 PostgreSQL(운영/CI), 없으면 PGlite(개발/단위 테스트, 메모리 또는 dataDir 파일).
 * 운영에서는 DATABASE_URL이 필수다(서버 진입점에서 강제).
 */
export async function openDb(url?: string, opts: OpenDbOptions = {}): Promise<Db> {
  let db: Db;
  if (url && /^postgres(ql)?:\/\//.test(url)) {
    const { openPgDb } = await import("./db-pg.js");
    db = await openPgDb(url, opts.schema);
  } else {
    const { openPgliteDb } = await import("./db-pglite.js");
    db = await openPgliteDb(url); // url이 없으면 메모리, 있으면 디렉터리 경로
  }
  if (opts.migrate !== false) await migrate(db);
  return db;
}
