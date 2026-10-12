import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { SignJWT, jwtVerify } from "jose";
import type { Config } from "./config.js";
import type { Ctx } from "./context.js";
import { createUser } from "./accounts.js";
import { badRequest, unauthorized } from "./errors.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const N = 16384;
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const dk = await scrypt(password, salt, KEYLEN, { N, r: 8, p: 1 });
  return `scrypt$${N}$${salt.toString("base64")}$${dk.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, saltB64, hashB64] = stored.split("$");
  if (alg !== "scrypt" || !n || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const dk = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, { N: Number(n), r: 8, p: 1 });
  return dk.length === expected.length && timingSafeEqual(dk, expected);
}

const key = (cfg: Config) => new TextEncoder().encode(cfg.jwtSecret);

export async function issueToken(cfg: Config, userId: string, role: string): Promise<string> {
  return new SignJWT({ role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${cfg.jwtTtlSec}s`)
    .sign(key(cfg));
}

export async function verifyToken(cfg: Config, token: string): Promise<{ userId: string; role: string }> {
  try {
    const { payload } = await jwtVerify(token, key(cfg), { algorithms: ["HS256"] });
    if (!payload.sub) throw new Error("no subject");
    return { userId: payload.sub, role: String(payload.role ?? "") };
  } catch {
    throw unauthorized("invalid or expired token");
  }
}

const MIN_PASSWORD = 10;
// 존재하지 않는 이메일로 로그인할 때도 같은 시간이 걸리도록 쓰는 더미 해시(계정 존재 여부 노출 방지)
let dummyHash: Promise<string> | undefined;

export async function signup(ctx: Ctx, input: { email: string; password: string; role: "user" | "creator"; region: string }) {
  if (typeof input.password !== "string" || input.password.length < MIN_PASSWORD || input.password.length > 200)
    throw badRequest("weak_password", `password must be ${MIN_PASSWORD}-200 characters`);
  const { userId, walletAddress } = await createUser(ctx, { ...input, passwordHash: await hashPassword(input.password) });
  return { userId, walletAddress, token: await issueToken(ctx.cfg, userId, input.role) };
}

export async function login(ctx: Ctx, input: { email: string; password: string }) {
  const rows = await ctx.db.query<{ id: string; role: string; password_hash: string | null }>(
    "SELECT id, role, password_hash FROM users WHERE email = $1",
    [String(input.email ?? "").toLowerCase()],
  );
  const u = rows[0];
  dummyHash ??= hashPassword("dummy-password-for-timing");
  const ok = await verifyPassword(String(input.password ?? ""), u?.password_hash ?? (await dummyHash));
  if (!u || !u.password_hash || !ok) throw unauthorized("invalid email or password");
  return { userId: u.id, token: await issueToken(ctx.cfg, u.id, u.role) };
}
