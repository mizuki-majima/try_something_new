/**
 * Admin API client (SPEC FR-18). The admin token lives in sessionStorage only (gone when the tab
 * closes) and travels as "X-Admin-Token". The user's own bearer token is never sent here.
 */
import {
  API,
  type AdminContactsResponse,
  type AdminModerate,
  type AdminReportsResponse,
  type AdminStats,
  type RecipeListResponse,
} from "@thirty/shared";
import { ApiClientError, errorMessage, request, type HttpMethod } from "./api";

const TOKEN_KEY = "thirty-days.admin-token";
let memoryToken: string | null = null;

function session(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function getAdminToken(): string | null {
  try {
    const v = session()?.getItem(TOKEN_KEY);
    if (v) return v;
  } catch {
    // fall through
  }
  return memoryToken;
}

export function setAdminToken(token: string): void {
  const t = token.trim();
  memoryToken = t;
  try {
    session()?.setItem(TOKEN_KEY, t);
  } catch {
    // keep the in-memory copy
  }
}

export function clearAdminToken(): void {
  memoryToken = null;
  try {
    session()?.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

export const WRONG_TOKEN_MESSAGE = "トークンが違います";

/** True when the server rejected the admin token. */
export function isWrongToken(err: unknown): boolean {
  return err instanceof ApiClientError && (err.status === 403 || err.status === 401);
}

export function adminErrorMessage(err: unknown): string {
  return isWrongToken(err) ? WRONG_TOKEN_MESSAGE : errorMessage(err);
}

type AdminRequestOptions = { body?: unknown; token?: string; signal?: AbortSignal };

/** A request with X-Admin-Token and without the user's bearer token. */
export function adminRequest<T>(method: HttpMethod, path: string, opts: AdminRequestOptions = {}): Promise<T> {
  const token = opts.token ?? getAdminToken();
  if (!token) return Promise.reject(new ApiClientError(403, "forbidden", WRONG_TOKEN_MESSAGE));
  return request<T>(method, path, {
    auth: "none",
    headers: { "X-Admin-Token": token },
    cache: "no-store",
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

export const fetchAdminStats = (token?: string) => adminRequest<AdminStats>("GET", API.adminStats, token ? { token } : {});
export const fetchAdminReports = () => adminRequest<AdminReportsResponse>("GET", API.adminReports);
export const fetchAdminContacts = () => adminRequest<AdminContactsResponse>("GET", API.adminContacts);
export const moderate = (input: AdminModerate) => adminRequest<void>("POST", API.adminModerate, { body: input });
export const setRecipeFeatured = (id: string, featured: boolean) =>
  adminRequest<void>("PATCH", API.adminRecipe(id), { body: { featured } });

/** Recipes as the public sees them (official + community), fresh from the network. */
export const fetchRecipesForAdmin = () => request<RecipeListResponse>("GET", API.recipes, { auth: "none", cache: "no-cache" });
