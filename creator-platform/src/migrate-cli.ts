// 배포 파이프라인에서 앱 시작 전에 따로 실행하는 마이그레이션: node dist/migrate-cli.js
import { openDb } from "./db.js";
import { migrate } from "./migrations.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = await openDb(url, { migrate: false });
const { applied } = await migrate(db);
console.log(applied.length ? `applied migrations: ${applied.join(", ")}` : "database is up to date");
await db.close();
