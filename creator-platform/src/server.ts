import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { buildApp } from "./app.js";
import { MockOffRamp } from "./payouts.js";
import { LocalFsStorage } from "./storage.js";
import { HttpWatermarkEngine } from "./watermark.js";

const cfg = loadConfig();
const prod = process.env.NODE_ENV === "production";
const url = process.env.DATABASE_URL ?? process.env.DATA_DIR; // DATA_DIR: 개발용 PGlite 파일 경로
if (prod && !process.env.DATABASE_URL) throw new Error("DATABASE_URL is required in production");
if (prod && process.env.OFFRAMP !== "mock")
  throw new Error("no real offramp implemented yet: set OFFRAMP=mock only for staging with mock payouts");

const db = await openDb(url, { migrate: process.env.MIGRATE_ON_START !== "0" });
// 워터마크 워커가 설정되지 않은 개발 환경에서는 engine=null -> 이미지 전달 요청이 503으로 실패한다(워터마크 없는 전달 금지)
const engine = cfg.workerUrl && cfg.workerKey ? new HttpWatermarkEngine(cfg.workerUrl, cfg.workerKey) : null;
const storage = new LocalFsStorage(cfg.storageDir); // TODO: 운영에서는 S3 호환 저장소 구현으로 교체
const app = await buildApp({ db, cfg }, new MockOffRamp(), { logger: true, trustProxy: process.env.TRUST_PROXY === "1", storage, engine });

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });

// 정상 종료: 새 요청을 받지 않고 진행 중인 요청을 마친 뒤 DB 연결을 닫는다
let closing = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    app.log.info({ sig }, "shutting down");
    try {
      await app.close();
      await db.close();
      process.exit(0);
    } catch (e) {
      console.error(e);
      process.exit(1);
    }
  });
}
