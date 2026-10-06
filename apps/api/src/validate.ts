import type { Context } from "hono";
import type { z } from "zod";
import { badRequest, MESSAGES } from "./errors";

/** Parse the JSON body and validate it. Schema errors surface as 400 bad_request with `fields`. */
export async function readJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest(MESSAGES.badJson);
  }
  return schema.parse(body);
}

/** Validate a path or query parameter (ZodError → 400). */
export function parseWith<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  return schema.parse(value);
}
