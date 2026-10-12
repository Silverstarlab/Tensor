import { createHash, randomUUID } from "node:crypto";
import type { Tx } from "./db.js";
import { badRequest, conflict, DomainError, notFound } from "./errors.js";

export const SYS = {
  ISSUANCE: "sys_issuance",
  ESCROW: "sys_escrow",
  REVENUE: "sys_platform_revenue",
  PAYOUT_HOLD: "sys_payout_hold",
} as const;

export interface Entry {
  accountId: string;
  /** 부호 있는 정수(코인). 양수 = 입금, 음수 = 출금. 한 거래 안의 합은 반드시 0 */
  amount: number;
}
export interface PostInput {
  idempotencyKey: string;
  type: string;
  entries: Entry[];
  memo?: Record<string, unknown>;
}
export interface PostResult {
  txId: string;
  replayed: boolean;
}

function normalize(entries: Entry[]): Entry[] {
  const merged = new Map<string, number>();
  for (const e of entries) {
    if (!Number.isSafeInteger(e.amount)) throw badRequest("invalid_amount", "amount must be a safe integer");
    merged.set(e.accountId, (merged.get(e.accountId) ?? 0) + e.amount);
  }
  const out = [...merged.entries()]
    .filter(([, a]) => a !== 0)
    .map(([accountId, amount]) => ({ accountId, amount }))
    .sort((a, b) => (a.accountId < b.accountId ? -1 : 1));
  if (out.length < 2) throw badRequest("invalid_entries", "a transaction needs at least two non-zero entries");
  if (out.reduce((s, e) => s + e.amount, 0) !== 0) throw badRequest("unbalanced", "entries must sum to zero");
  return out;
}

/**
 * 원장의 유일한 쓰기 경로. 반드시 DB 트랜잭션 안에서 호출한다.
 * - 이중기입(합 = 0), 멱등성 키, 계정 행 잠금(id 순서로 데드락 방지), 잔액 부족 검사
 */
export async function post(tx: Tx, input: PostInput): Promise<PostResult> {
  if (!input.idempotencyKey) throw badRequest("missing_idempotency_key", "idempotencyKey is required");
  const entries = normalize(input.entries);
  const requestHash = createHash("sha256").update(JSON.stringify([input.type, entries])).digest("hex");

  const existing = await tx.query<{ id: string; request_hash: string }>(
    "SELECT id, request_hash FROM ledger_transactions WHERE idempotency_key = $1",
    [input.idempotencyKey],
  );
  if (existing[0]) {
    if (existing[0].request_hash !== requestHash)
      throw conflict("idempotency_conflict", "idempotency key was already used with a different request");
    return { txId: existing[0].id, replayed: true };
  }

  const ids = entries.map((e) => e.accountId);
  const accounts = await tx.query<{ id: string; balance: number; allow_negative: boolean }>(
    "SELECT id, balance, allow_negative FROM ledger_accounts WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE",
    [ids],
  );
  const byId = new Map(accounts.map((a) => [a.id, a]));
  for (const e of entries) {
    const a = byId.get(e.accountId);
    if (!a) throw notFound(`ledger account ${e.accountId}`);
    if (!a.allow_negative && a.balance + e.amount < 0)
      throw new DomainError(409, "insufficient_funds", "insufficient coin balance", {
        accountId: a.id,
        balance: a.balance,
        needed: -e.amount,
      });
  }

  const txId = randomUUID();
  await tx.query(
    "INSERT INTO ledger_transactions (id, idempotency_key, type, request_hash, memo) VALUES ($1,$2,$3,$4,$5)",
    [txId, input.idempotencyKey, input.type, requestHash, input.memo ? JSON.stringify(input.memo) : null],
  );
  for (const e of entries) {
    await tx.query("INSERT INTO ledger_entries (tx_id, account_id, amount) VALUES ($1,$2,$3)", [
      txId,
      e.accountId,
      e.amount,
    ]);
    await tx.query("UPDATE ledger_accounts SET balance = balance + $1 WHERE id = $2", [e.amount, e.accountId]);
  }
  return { txId, replayed: false };
}

export async function getBalance(tx: Tx, accountId: string): Promise<number> {
  const r = await tx.query<{ balance: number }>("SELECT balance FROM ledger_accounts WHERE id = $1", [accountId]);
  if (!r[0]) throw notFound(`ledger account ${accountId}`);
  return r[0].balance;
}

export interface LedgerCheck {
  ok: boolean;
  problems: string[];
}

/** 원장 무결성 검증. 운영에서는 주기적으로 실행하고 이상 시 알림을 보낸다. */
export async function verifyLedger(tx: Tx): Promise<LedgerCheck> {
  const problems: string[] = [];

  const total = await tx.query<{ s: number }>("SELECT COALESCE(SUM(balance),0)::bigint AS s FROM ledger_accounts");
  if (total[0]!.s !== 0) problems.push(`sum of all balances is ${total[0]!.s}, expected 0`);

  const unbalanced = await tx.query<{ tx_id: string }>(
    "SELECT tx_id FROM ledger_entries GROUP BY tx_id HAVING SUM(amount) <> 0",
  );
  for (const r of unbalanced) problems.push(`transaction ${r.tx_id} does not sum to zero`);

  const drift = await tx.query<{ id: string; balance: number; s: number }>(
    `SELECT a.id, a.balance, COALESCE(e.s,0)::bigint AS s
       FROM ledger_accounts a
       LEFT JOIN (SELECT account_id, SUM(amount) AS s FROM ledger_entries GROUP BY account_id) e ON e.account_id = a.id
      WHERE a.balance <> COALESCE(e.s,0)`,
  );
  for (const r of drift) problems.push(`account ${r.id} balance ${r.balance} != entries sum ${r.s}`);

  const esc = await tx.query<{ owed: number; bal: number }>(
    `SELECT COALESCE((SELECT SUM(total - released - refunded) FROM escrow_schedules),0)::bigint AS owed,
            (SELECT balance FROM ledger_accounts WHERE id = 'sys_escrow') AS bal`,
  );
  if (esc[0]!.owed !== esc[0]!.bal)
    problems.push(`escrow balance ${esc[0]!.bal} != outstanding schedules ${esc[0]!.owed}`);

  return { ok: problems.length === 0, problems };
}
