import type { Config } from "./config.js";
import type { Db } from "./db.js";

export interface Ctx {
  db: Db;
  cfg: Config;
}
