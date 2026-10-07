import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import type { Context, MiddlewareHandler } from "hono";
import type { User } from "@thirty/shared";
import { DEFAULT_IP_HASH_KEY } from "./config";
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

/** The 8 groups of a valid IPv6 address (already checked with isIPv6), "::" and a dotted IPv4 tail expanded. */
function ipv6Groups(ip: string): number[] {
  let s = ip;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const [a, b, c, d] = tail.split(".").map(Number) as [number, number, number, number];
    s = `${s.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = s.includes("::") ? (s.split("::") as [string, string]) : [s, undefined];
  const h = head ? head.split(":") : [];
  const t = rest ? rest.split(":") : [];
  const groups = rest === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill("0"), ...t];
  return groups.map((g) => parseInt(g, 16));
}

/**
 * What a rate limit counts as "one client": an IPv4 address, or the /64 prefix of an IPv6 address
 * (one home or one VPS gets at least a /64, so counting single IPv6 addresses would limit nothing).
 * An IPv4-mapped IPv6 address counts as its IPv4 address. Anything unparsable is used as it is.
 */
export function ipKey(raw: string): string {
  let ip = raw.trim().toLowerCase();
  if (ip.startsWith("[")) ip = ip.slice(1, ip.includes("]") ? ip.indexOf("]") : undefined);
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  if (isIPv4(ip)) return ip;
  if (!isIPv6(ip)) return raw.trim();
  const g = ipv6Groups(ip);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255].join(".");
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

/** HMAC-SHA256 of ipKey(ip) with a secret, so stored rate-limit keys cannot be reversed by enumerating IPs. */
export function hashIp(ip: string, secret: string): string {
  return createHmac("sha256", secret).update(ipKey(ip)).digest("hex");
}

/**
 * The client's rate-limit key (CloudFront puts the viewer address in x-viewer-ip). Raw IPs are
 * never stored or logged. The secret comes from SSM (/thirty-days/ip-hash-key) on AWS.
 */
export function clientIpHash(deps: Pick<Deps, "secrets" | "config">, c: Context): string {
  const viewer = c.req.header("x-viewer-ip")?.trim();
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  const secret = deps.secrets.ipHashKey ?? deps.config.ipHashKey ?? DEFAULT_IP_HASH_KEY;
  return hashIp(viewer || forwarded || "unknown", secret);
}
