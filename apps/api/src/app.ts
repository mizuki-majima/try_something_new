import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { routePath } from "hono/route";
import { safeEqual } from "./auth";
import { errorResponse, MESSAGES, onError, onNotFound } from "./errors";
import { log } from "./log";
import type { Deps } from "./ports";
import { adminRoutes } from "./routes/admin";
import { suggestionRoutes } from "./routes/suggestions";
import { challengesRoutes } from "./routes/challenges";
import { cohortsRoutes } from "./routes/cohorts";
import { healthRoutes } from "./routes/health";
import { meRoutes } from "./routes/me";
import { pushRoutes } from "./routes/push";
import { recipesRoutes } from "./routes/recipes";
import { reportsRoutes } from "./routes/reports";
import { sessionRoutes } from "./routes/session";
import { sharesRoutes } from "./routes/shares";
import type { AppEnv } from "./types";

/** Request bodies (including a base64 share image) are capped at 1MB (SPEC: API). */
export const MAX_BODY_BYTES = 1024 * 1024;

/** One log line per request: method, matched route pattern (not the raw path), status, ms. */
function requestLog(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const started = performance.now();
    await next();
    const route = routePath(c, -1);
    const status = c.res.status;
    const fields = {
      method: c.req.method,
      route: route === "*" || route === "/*" ? "(unmatched)" : route,
      status,
      ms: Math.round(performance.now() - started),
      uid: c.get("uid") as string | undefined,
    };
    if (status >= 500) log.error("request", fields);
    else log.info("request", fields);
  };
}

/** The accepted origin-verify values: ORIGIN_VERIFY is a comma-separated list ("new,old" while rotating). */
export function originVerifyValues(configured: string | undefined): string[] {
  return (configured ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * CloudFront adds a secret header; anything else (e.g. the API Gateway URL called directly) is refused.
 * Several values are accepted so a rotation never refuses the edges that still send the old one
 * (CloudFront takes minutes to propagate, the Lambda switches in seconds). Every value is compared
 * in constant time, without stopping at the first match.
 *
 * Unset (local runs, tests): no check. Set but with no usable value ("", " ", ","): fail closed,
 * every request is refused (NF-6). A broken parameter must never turn the check off.
 */
function originVerify(configured: string | undefined): MiddlewareHandler<AppEnv> {
  const expected = originVerifyValues(configured);
  const enforced = configured !== undefined;
  if (enforced && expected.length === 0) {
    log.error("ORIGIN_VERIFY is set but holds no value; refusing every request", {});
  }
  return async (c, next) => {
    if (enforced) {
      const given = c.req.header("x-origin-verify");
      let ok = false;
      if (given) for (const value of expected) ok = safeEqual(given, value) || ok;
      if (!ok) return errorResponse(c, 403, "forbidden", MESSAGES.forbidden);
    }
    await next();
  };
}

function hasBody(c: { req: { header(name: string): string | undefined } }): boolean {
  const length = c.req.header("content-length");
  return (length !== undefined && length !== "0") || c.req.header("transfer-encoding") !== undefined;
}

/** POST / PUT / PATCH (and DELETE with a body) must be JSON. Also keeps cross-site form posts out. */
function requireJson(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const method = c.req.method;
    const mutating = method === "POST" || method === "PUT" || method === "PATCH" || (method === "DELETE" && hasBody(c));
    if (mutating) {
      const type = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (type !== "application/json") return errorResponse(c, 415, "unsupported_media_type", MESSAGES.unsupportedMediaType);
    }
    await next();
  };
}

/** API responses are per-user and must not be cached by browsers or proxies. */
function noStore(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    if (c.req.path.startsWith("/api/") && !c.res.headers.has("cache-control")) c.header("Cache-Control", "no-store");
  };
}

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();

  app.use("*", requestLog());
  app.use("*", noStore());
  app.use("*", originVerify(deps.config.originVerify));
  app.use("*", requireJson());
  app.use(
    "*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => errorResponse(c, 413, "payload_too_large", MESSAGES.payloadTooLarge),
    }),
  );

  // Every router registers absolute paths and is mounted at "/".
  app.route("/", healthRoutes(deps));
  app.route("/", sessionRoutes(deps));
  app.route("/", meRoutes(deps));
  app.route("/", challengesRoutes(deps));
  app.route("/", cohortsRoutes(deps));
  app.route("/", recipesRoutes(deps));
  app.route("/", suggestionRoutes(deps));
  app.route("/", sharesRoutes(deps));
  app.route("/", pushRoutes(deps));
  app.route("/", reportsRoutes(deps));
  app.route("/", adminRoutes(deps));

  app.onError(onError);
  app.notFound(onNotFound);
  return app;
}

export type App = ReturnType<typeof createApp>;
