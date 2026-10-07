/**
 * Typed client for the HTTP API. Paths come from API in @thirty/shared, types from schemas.ts.
 *
 *   const { recipes } = await request<RecipeListResponse>("GET", API.recipes);
 *   await request<{ story: Story }>("POST", API.stories(id), { body, auth: "required" });
 *
 * auth: "required" creates the anonymous account on first use; "optional" (default) sends the
 * token when there is one (public lists use it for isMine); "none" never sends it.
 * Requests are never retried automatically (offline-safe writes go through the store's outbox).
 */
import { send, ApiClientError, type SendOptions } from "./http";
import { ensureSession, getToken, markSessionInvalid } from "./session";

export {
  ApiClientError,
  isApiClientError,
  isQuotaLimit,
  errorMessage,
  DEFAULT_TIMEOUT_MS,
  THROTTLED_MESSAGE,
  type ClientErrorCode,
} from "./http";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type AuthMode = "required" | "optional" | "none";
export type RequestOptions = SendOptions & { auth?: AuthMode };

export async function request<T>(method: HttpMethod, path: string, opts: RequestOptions = {}): Promise<T> {
  const { auth = "optional", ...rest } = opts;
  let token: string | null = null;
  if (auth === "required") token = (await ensureSession()).token;
  else if (auth === "optional") token = getToken();

  const headers: Record<string, string> = { ...rest.headers };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    return await send<T>(method, path, { ...rest, headers });
  } catch (err) {
    // Only the token we sent can be blamed; another tab may already have replaced it.
    if (token && err instanceof ApiClientError && err.status === 401 && getToken() === token) markSessionInvalid();
    throw err;
  }
}
