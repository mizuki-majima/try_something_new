import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import type { User } from "@thirty/shared";
import { getTokenOwner, getUser } from "./db/users";
import { forbidden, unauthorized } from "./errors";
import type { Deps } from "./ports";
import type { AppEnv } from "./types";

/** 32 random bytes, base64url (43 characters). Only its SHA-256 is stored. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Constant-time string comparison (hashing first hides the length too). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;

function bearerToken(c: Context): string | undefined {
  const header = c.req.header("authorization");
  const m = header?.match(/^Bearer\s+(\S+)\s*$/i);
  return m && TOKEN_RE.test(m[1]!) ? m[1] : undefined;
}

// ---------- token → uid cache ----------
// Only the uid is cached; the user item is read on every request, so a deleted account
// stops working immediately even while its token is still cached here.

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 5_000;
const tokenCache = new Map<string, { uid: string; exp: number }>();

function cacheGet(hash: string): string | undefined {
  const hit = tokenCache.get(hash);
  if (!hit) return undefined;
  if (hit.exp < Date.now()) {
    tokenCache.delete(hash);
    return undefined;
  }
  return hit.uid;
}

function cacheSet(hash: string, uid: string): void {
  if (tokenCache.size >= CACHE_MAX) {
    const oldest = tokenCache.keys().next().value;
    if (oldest !== undefined) tokenCache.delete(oldest);
  }
  tokenCache.set(hash, { uid, exp: Date.now() + CACHE_TTL_MS });
}

export function forgetTokens(hashes: string[]): void {
  for (const h of hashes) tokenCache.delete(h);
}

/** undefined: no token sent. null: token sent but not valid. */
async function resolveUser(deps: Deps, c: Context): Promise<User | null | undefined> {
  const token = bearerToken(c);
  if (!token) return c.req.header("authorization") ? null : undefined;
  const hash = sha256(token);
  let uid = cacheGet(hash);
  if (!uid) {
    uid = await getTokenOwner(deps, hash);
    if (!uid) return null;
    cacheSet(hash, uid);
  }
  const user = await getUser(deps, uid);
  if (!user) {
    tokenCache.delete(hash);
    return null;
  }
  return user;
}

export function requireUser(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = await resolveUser(deps, c);
    if (!user) throw unauthorized();
    c.set("user", user);
    c.set("uid", user.id);
    await next();
  };
}

/** Public routes that personalise when a valid token is present (isMine, cheeredToday). Bad tokens are ignored. */
export function optionalUser(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = await resolveUser(deps, c);
    if (user) {
      c.set("user", user);
      c.set("uid", user.id);
    }
    await next();
  };
}

export function requireAdmin(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const expected = deps.secrets.adminToken;
    const given = c.req.header("x-admin-token");
    if (!expected || !given || !safeEqual(given, expected)) throw forbidden("管理トークンが正しくありません");
    await next();
  };
}

/** SHA-256 of the client IP, for rate limiting. Raw IPs are never stored or logged. */
export function clientIpHash(c: Context): string {
  const viewer = c.req.header("x-viewer-ip")?.trim();
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return sha256(viewer || forwarded || "unknown");
}
