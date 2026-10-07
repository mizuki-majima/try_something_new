import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import type { Context, MiddlewareHandler } from "hono";
import type { User } from "@thirty/shared";
import { DEFAULT_IP_HASH_KEY, isTestEnv } from "./config";
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

type ParsedIp = { v4: [number, number, number, number] } | { v6: number[] } | { raw: string };

/** Brackets, zone ids and IPv4-mapped IPv6 addresses handled; anything unparsable is kept as it is. */
function parseIp(raw: string): ParsedIp {
  let ip = raw.trim().toLowerCase();
  if (ip.startsWith("[")) ip = ip.slice(1, ip.includes("]") ? ip.indexOf("]") : undefined);
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  if (isIPv4(ip)) return { v4: ip.split(".").map(Number) as [number, number, number, number] };
  if (!isIPv6(ip)) return { raw: raw.trim() };
  const g = ipv6Groups(ip);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return { v4: [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255] };
  }
  return { v6: g };
}

const hex16 = (x: number) => x.toString(16);

/**
 * What a rate limit counts as "one client": an IPv4 address, or the /56 prefix of an IPv6 address.
 * One home gets at least a /64, and Japanese IPoE (FLET'S v6 / IPv6 IPoE) homes get a /56 = 256 /64s,
 * so counting anything finer would let one home open 256 times the quota (security-3).
 * An IPv4-mapped IPv6 address counts as its IPv4 address. Anything unparsable is used as it is.
 */
export function ipKey(raw: string): string {
  const p = parseIp(raw);
  if ("raw" in p) return p.raw;
  if ("v4" in p) return p.v4.join(".");
  const g = p.v6;
  return `${g.slice(0, 3).map(hex16).join(":")}:${hex16(g[3]! & 0xff00)}::/56`;
}

/**
 * The network a client is on, coarser than ipKey: an IPv4 /24 or an IPv6 /48 (what one person can
 * easily hold: a home, a VPS range, a free tunnel broker's /48). Auto-hide needs reporters from at
 * least AUTO_HIDE_MIN_NETWORKS of these (security-4), so one person's accounts on one connection
 * cannot hide anything.
 */
export function networkKey(raw: string): string {
  const p = parseIp(raw);
  if ("raw" in p) return p.raw;
  if ("v4" in p) return `${p.v4.slice(0, 3).join(".")}.0/24`;
  return `${p.v6.slice(0, 3).map(hex16).join(":")}::/48`;
}

/**
 * A wider network than networkKey, for the per-network new-session limit (R11): an IPv4 /16 or an
 * IPv6 /48. One actor can hold many /56s (a tunnel broker's /48) or many IPv4 addresses in one range,
 * but rarely many /16s or /48s, so no single network can use up the global ceiling.
 */
export function wideNetworkKey(raw: string): string {
  const p = parseIp(raw);
  if ("raw" in p) return p.raw;
  if ("v4" in p) return `${p.v4.slice(0, 2).join(".")}.0.0/16`;
  return `${p.v6.slice(0, 3).map(hex16).join(":")}::/48`;
}

/**
 * The secret for the HMACs below. On AWS it comes from SSM (/thirty-days/ip-hash-key, loadSecrets
 * fails without it); local.ts passes DEFAULT_IP_HASH_KEY itself. The public default is used only
 * under tests: anywhere else a missing key is a 500, never a reversible hash (NF-4).
 */
export function ipHashSecret(deps: Pick<Deps, "secrets" | "config">): string {
  const secret = deps.secrets.ipHashKey ?? deps.config.ipHashKey;
  if (secret) return secret;
  if (isTestEnv()) return DEFAULT_IP_HASH_KEY;
  throw new Error("IP hash key is not configured (IP_HASH_KEY or IP_HASH_KEY_PARAM)");
}

/** HMAC-SHA256 of ipKey(ip) with a secret, so stored rate-limit keys cannot be reversed by enumerating IPs. */
export function hashIp(ip: string, secret: string): string {
  return createHmac("sha256", secret).update(ipKey(ip)).digest("hex");
}

/** HMAC of networkKey(ip) (domain-separated from hashIp), shortened: only compared for equality. */
export function hashNetwork(ip: string, secret: string): string {
  return createHmac("sha256", secret).update(`net:${networkKey(ip)}`).digest("hex").slice(0, 32);
}

/** HMAC of wideNetworkKey(ip), domain-separated: 2^16 IPv4 /16s are trivial to enumerate without the key. */
export function hashWideNetwork(ip: string, secret: string): string {
  return createHmac("sha256", secret).update(`wide:${wideNetworkKey(ip)}`).digest("hex");
}

/** The viewer's address as CloudFront passes it (x-viewer-ip), or the first x-forwarded-for hop. */
function clientIp(c: Context): string {
  const viewer = c.req.header("x-viewer-ip")?.trim();
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return viewer || forwarded || "unknown";
}

/**
 * The client's rate-limit key (CloudFront puts the viewer address in x-viewer-ip). Raw IPs are
 * never stored or logged. The secret comes from SSM (/thirty-days/ip-hash-key) on AWS.
 */
export function clientIpHash(deps: Pick<Deps, "secrets" | "config">, c: Context): string {
  return hashIp(clientIp(c), ipHashSecret(deps));
}

/** The client's network (see networkKey), as a keyed hash. */
export function clientNetworkHash(deps: Pick<Deps, "secrets" | "config">, c: Context): string {
  return hashNetwork(clientIp(c), ipHashSecret(deps));
}

/** The client's wider network (see wideNetworkKey), as a keyed hash: the per-network session limit. */
export function clientWideNetworkHash(deps: Pick<Deps, "secrets" | "config">, c: Context): string {
  return hashWideNetwork(clientIp(c), ipHashSecret(deps));
}
