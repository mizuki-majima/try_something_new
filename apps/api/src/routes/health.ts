import { Hono } from "hono";
import { API } from "@thirty/shared";
import type { Deps } from "../ports";
import type { AppEnv } from "../types";

export function healthRoutes(_deps: Deps) {
  const r = new Hono<AppEnv>();
  r.get(API.health, (c) => c.json({ ok: true as const }));
  return r;
}
