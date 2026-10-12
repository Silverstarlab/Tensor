export interface Config {
  /** 플랫폼 수수료 (basis points, 1000 = 10%) */
  feeBps: number;
  /** 크리에이터 출금 보류 기간(일) */
  payoutHoldDays: number;
  minPayoutCoins: number;
  maxChargeCoins: number;
  /** 워터마크 ID(wm_id) 생성용 비밀 키. 유출되면 구독자 역추적이 가능해지므로 KMS에서 주입할 것 */
  wmSecret: string;
  urlSecret: string;
  adminKey: string;
  webhookSecret: string;
  /** JWT 서명 키 (HS256). 운영에서는 32자 이상 */
  jwtSecret: string;
  jwtTtlSec: number;
  signedUrlTtlSec: number;
  mediaBaseUrl: string;
  /** 워터마크 워커(내부 서비스) 주소와 API 키. 운영에서는 필수 */
  workerUrl: string | null;
  workerKey: string | null;
  /** 로컬 개발용 객체 저장소 경로 (운영에서는 S3 호환 저장소 구현으로 교체) */
  storageDir: string;
  mediaFormat: "png" | "jpeg";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const prod = env.NODE_ENV === "production";
  const secret = (name: string, devDefault: string): string => {
    const v = env[name];
    if (v) return v;
    if (prod) throw new Error(`${name} is required in production`);
    return devDefault;
  };
  const cfg: Config = {
    feeBps: Number(env.FEE_BPS ?? 1000),
    payoutHoldDays: Number(env.PAYOUT_HOLD_DAYS ?? 7),
    minPayoutCoins: Number(env.MIN_PAYOUT_COINS ?? 100),
    maxChargeCoins: Number(env.MAX_CHARGE_COINS ?? 1_000_000),
    wmSecret: secret("WM_SECRET", "dev-wm-secret-change-me"),
    urlSecret: secret("URL_SECRET", "dev-url-secret-change-me"),
    adminKey: secret("ADMIN_KEY", "dev-admin-key"),
    webhookSecret: secret("WEBHOOK_SECRET", "dev-webhook-secret"),
    jwtSecret: secret("JWT_SECRET", "dev-jwt-secret-change-me-dev-jwt-secret"),
    jwtTtlSec: Number(env.JWT_TTL_SEC ?? 3600),
    signedUrlTtlSec: Number(env.SIGNED_URL_TTL_SEC ?? 60),
    mediaBaseUrl: env.MEDIA_BASE_URL ?? "http://localhost:3000",
    workerUrl: env.WATERMARK_WORKER_URL ?? null,
    workerKey: env.WATERMARK_WORKER_KEY ?? null,
    storageDir: env.STORAGE_DIR ?? "./data/storage",
    mediaFormat: env.MEDIA_FORMAT === "png" ? "png" : "jpeg",
  };
  if (prod) {
    // 운영에서는 개발용 기본값/짧은 비밀키를 거부한다
    for (const k of ["wmSecret", "urlSecret", "adminKey", "webhookSecret", "jwtSecret"] as const) {
      if (cfg[k].length < 32 || cfg[k].startsWith("dev-")) throw new Error(`${k}: use a random secret of at least 32 characters in production`);
    }
  }
  if (prod) {
    // 워터마크 없이 원본을 내보내는 일이 없도록, 운영에서는 워커 설정이 없으면 시작하지 않는다
    if (!cfg.workerUrl || !cfg.workerKey || cfg.workerKey.length < 32 || cfg.workerKey.startsWith("dev-"))
      throw new Error("WATERMARK_WORKER_URL and a random WATERMARK_WORKER_KEY (>= 32 chars) are required in production");
  }
  return cfg;
}
