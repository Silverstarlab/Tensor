import { randomBytes, randomUUID } from "node:crypto";
import type { Ctx } from "./context.js";
import type { Tx } from "./db.js";
import { badRequest, conflict, notFound } from "./errors.js";
import { getBalance } from "./ledger.js";
import { priceFor } from "./pricing.js";

export interface User {
  id: string;
  email: string;
  role: "user" | "creator";
  region: string;
  kyc_status: string;
}

export async function createUser(ctx: Ctx, input: { email: string; role: "user" | "creator"; region: string; passwordHash?: string }) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email)) throw badRequest("invalid_email", "invalid email");
  if (input.role !== "user" && input.role !== "creator") throw badRequest("invalid_role", "role must be user or creator");
  if (!priceFor(input.region)) throw badRequest("unsupported_region", `region ${input.region} is not supported`);

  const userId = randomUUID();
  const kind = input.role === "creator" ? "CREATOR_WALLET" : "USER_WALLET";
  const address = "wlt_" + randomBytes(10).toString("hex");
  try {
    await ctx.db.transaction(async (tx) => {
      await tx.query("INSERT INTO users (id,email,role,region,password_hash) VALUES ($1,$2,$3,$4,$5)", [
        userId,
        input.email.toLowerCase(),
        input.role,
        input.region,
        input.passwordHash ?? null,
      ]);
      await tx.query("INSERT INTO ledger_accounts (id,kind,owner_user_id,address) VALUES ($1,$2,$3,$4)", [
        "acct_" + userId,
        kind,
        userId,
        address,
      ]);
    });
  } catch (e: any) {
    if (e?.code === "23505") throw conflict("email_taken", "email already registered");
    throw e;
  }
  return { userId, walletAddress: address };
}

export async function getUser(tx: Tx, userId: string): Promise<User> {
  const r = await tx.query<User>("SELECT id,email,role,region,kyc_status FROM users WHERE id = $1", [userId]);
  if (!r[0]) throw notFound("user");
  return r[0];
}

export const walletAccountId = (userId: string) => "acct_" + userId;

export async function getWallet(ctx: Ctx, userId: string) {
  await getUser(ctx.db, userId);
  const r = await ctx.db.query<{ address: string }>("SELECT address FROM ledger_accounts WHERE id = $1", [
    walletAccountId(userId),
  ]);
  return { address: r[0]!.address, balanceCoins: await getBalance(ctx.db, walletAccountId(userId)) };
}

export async function setKycStatus(ctx: Ctx, userId: string, status: "NONE" | "PENDING" | "VERIFIED" | "REJECTED") {
  await getUser(ctx.db, userId);
  await ctx.db.query("UPDATE users SET kyc_status = $1 WHERE id = $2", [status, userId]);
}
