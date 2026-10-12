# Creator Platform (v0.3 · 백엔드 + 워터마크 워커)

폐쇄형 코인 원장 + 구독/에스크로 + 구독자별 워터마크 ID 유출 추적 + 출금 정산 백엔드 프로토타입.
기획안 15~17장의 아키텍처를 구현한다. TypeScript / Node 22 / Fastify / PostgreSQL(개발·테스트는 PGlite).

## 실행

```bash
npm install
npm test                      # 17개 테스트, 메모리 PGlite
TEST_DATABASE_URL=postgres://user:pw@localhost:5432/db npm test   # 같은 테스트를 실제 PostgreSQL에서
npm run typecheck
npm run dev                   # http://localhost:3000 (개발용 메모리 DB, 개발용 기본 비밀키)
```

## 배포

```bash
cp .env.example .env          # 비밀 값은 `openssl rand -hex 32` 로 각각 새로 생성
docker compose up --build     # 앱 + PostgreSQL 16 (시작 시 마이그레이션 자동 적용)
```

- 마이그레이션을 따로 돌리려면: `MIGRATE_ON_START=0` 으로 앱을 띄우고 배포 파이프라인에서 `node dist/migrate-cli.js` 실행.
- 헬스체크: `/health`(생존), `/ready`(DB 연결 확인). SIGTERM 시 진행 중 요청을 마치고 정상 종료.
- **일 배치 스케줄링**: 플랫폼 cron으로 `POST /admin/jobs/release-escrow` 와 `/admin/jobs/settle-payouts` 를 하루 1회 호출 (둘 다 멱등).
- 운영(`NODE_ENV=production`)에서는 `DATABASE_URL` 필수, 32자 미만이거나 `dev-` 로 시작하는 비밀키는 시작 자체를 거부한다.
- 로드밸런서 뒤에서는 `TRUST_PROXY=1` (레이트 리밋이 실제 클라이언트 IP를 쓰도록).
- 로그에서 `Authorization`, `x-admin-key`, `x-webhook-secret` 헤더는 가려진다.

## 구조

| 파일 | 역할 |
|---|---|
| `src/ledger.ts` | **원장 코어.** 이중기입(합=0), 멱등성 키, 행 잠금, 잔액 부족 검사, 무결성 검증(`verifyLedger`) |
| `src/schema.ts` | 스키마. 원장 테이블은 DB 트리거로 UPDATE/DELETE 차단 |
| `src/accounts.ts` | 가입 시 역할별 지갑(내부 원장 계정) 자동 생성, KYC 상태 |
| `src/auth.ts` | scrypt 비밀번호 해시, JWT(HS256) 발급/검증, 가입/로그인 |
| `src/db.ts`, `db-pg.ts`, `db-pglite.ts` | DB 추상화. `DATABASE_URL`이면 PostgreSQL(데드락 재시도 포함), 아니면 개발용 PGlite |
| `src/migrations.ts` | 버전 관리 마이그레이션 (advisory lock으로 동시 시작 안전). 배포된 마이그레이션은 수정 금지 |
| `src/charges.ts` | 코인 충전. PG 웹훅 중복에도 한 번만 발행 |
| `src/subscriptions.ts` | 구독, 에스크로 일할 정산(수수료 분리), 해지 환불, 만료/갱신 |
| `src/deliveries.ts` | 열람 권한, `wm_id`(HMAC) 생성, 만료 서명 URL |
| `src/leaks.ts` | `wm_id` → 구독자 역조회. 자동 제재 없이 OPEN 상태로 검수 |
| `src/payouts.ts` | 출금 신청 → 보류 기간 → 오프램프 → 코인 소각 |
| `src/watermark.ts` | 워터마크 엔진 인터페이스 (실제 구현체는 아직 없음) |
| `src/app.ts` | REST API |

## 핵심 설계

- 코인 = 정수. 1코인 = 100원 기준, 지역별 가격표는 `src/pricing.ts` (자리표시자 값).
- 지갑은 내부 원장 계정이다. 온체인 키는 아직 없다(트레저리/앵커링 단계에서 추가).
- 코인 흐름: `ISSUANCE → 사용자 지갑 → ESCROW → 크리에이터 지갑 / 플랫폼 수익`, 출금은 `→ PAYOUT_HOLD → ISSUANCE(소각)`.
- 항상 성립하는 불변식: 모든 계정 잔액 합 = 0, 각 거래 합 = 0, 에스크로 잔액 = 미정산 일정 합.

## API

| 엔드포인트 | 인증 | 설명 |
|---|---|---|
| `POST /auth/signup`, `/auth/login` | 없음 (분당 10회 제한) | 가입 + 지갑 생성 / JWT 발급 |
| `GET /me/wallet` | Bearer JWT | 잔액 |
| `POST /charges` | Bearer JWT | 코인 N개 충전 요청 |
| `POST /webhooks/pg/confirm` | 웹훅 시크릿 | 결제 확정 → 코인 발행 |
| `POST /plans`, `/subscriptions`, `/subscriptions/:id/cancel` | Bearer JWT | 플랜/구독/해지 |
| `POST /contents`, `GET /contents/:id/access` | Bearer JWT | 업로드 / 서명 URL (wm_id는 응답에 없음) |
| `POST /payouts` | Bearer JWT | 출금 신청 (KYC 필수) |
| `POST /admin/jobs/release-escrow`, `/settle-payouts` | 관리자 | 일 배치 |
| `POST /admin/leaks`, `/admin/leaks/:id/review` | 관리자 | 유출 등록과 검수 |
| `GET /admin/ledger/verify` | 관리자 | 원장 무결성 검증 |
| `POST /internal/media/resolve` | 관리자 | 미디어 서버가 삽입할 wm_id 조회 |

## 검증 상태

- 타입체크, 17개 테스트가 **PGlite와 실제 PostgreSQL 16 양쪽에서** 통과. 실제 PostgreSQL에서만 드러나는 동시성 버그(동시 구독 요청이 DB 내부 오류로 나가던 문제)를 이 과정에서 발견해 수정함.
- 운영 의존성만 설치한 컴파일 결과물을 `NODE_ENV=production`으로 실제 PostgreSQL에 붙여 실행: 가입/로그인/지갑 조회, 비밀키·DB URL 가드, 보안 헤더, 정상 종료 확인.
- **Docker 이미지 빌드와 GitHub Actions 워크플로는 이 환경에서 실행해 보지 못했다** (Docker 없음, YAML 문법만 확인). 첫 배포 때 확인할 것.

## 아직 구현되지 않은 것 (운영 전 필수)

- **실제 워터마킹**: 인터페이스와 `InsecureStubWatermark`(테스트용, 보안 기능 아님)만 있다. 다음 핵심 작업(로드맵 2단계).
- **실제 PG 연동, 오프램프, 환율(FX)**: `MockOffRamp`만 있어 운영에서는 `OFFRAMP=mock`을 명시해야 시작된다(스테이징 전용). 출금 환산은 지역 가격표를 임시로 쓴다.
- 이메일 인증, 비밀번호 재설정, 토큰 갱신/폐기, 2FA, 관리자 인증 고도화(현재는 고정 키 헤더)
- 머클 앵커링, 유출 크롤러, 이상 접근 탐지, 감사 로그, 메트릭/알림
- 법률 검토 전에는 실제 결제/출금을 연결하지 말 것.


---

## 2단계 추가분 (워터마크 엔진, 미디어 전달, 유출 분석)

- `worker/` : 이미지 워터마크 엔진(Python). 자세한 구조와 현재 상태는 `docs/project_handoff.json` 참고.
  - `worker/wmark/core.py` 엔진 본체 / `attacks.py` 공격 모음 / `bench.py` 벤치마크 / `colab_bench.py` Colab용 러너 / `server.py` HTTP 워커(FastAPI)
  - 실행: `cd worker && pip install -r requirements.txt && python3 -m unittest discover -s tests`
- 백엔드 추가 모듈: `src/media.ts`(서명 URL 검증 후 구독자별 워터마크 삽입 전달, 엔진 장애 시 503으로 막음), `src/storage.ts`(경로 탈출 방지), `src/watermark.ts`(엔진 인터페이스, HTTP 클라이언트)
- 추가 API: `POST /contents/upload`, `GET /media/:id`, `POST /admin/leaks/analyze`
- 테스트: TypeScript 24개(`npm test`, 실제 파이썬 워커 결합 테스트 포함, 파이썬/의존성이 없으면 해당 테스트만 건너뜀), Python 12개
- 환경변수 추가: `WATERMARK_WORKER_URL`, `WATERMARK_WORKER_KEY`(운영 필수), `STORAGE_DIR`, `MEDIA_FORMAT`(jpeg|png)
- 워커 환경변수: `WM_KEY`(hex, 운영 필수), `WORKER_API_KEY`(운영 필수), `WORKER_ENV=production`, `WM_STRENGTH`
