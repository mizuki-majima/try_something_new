/** Lambda "api": API Gateway HTTP API → Hono. Everything is built once per cold start. */
import { handle } from "hono/aws-lambda";
import { createApp } from "./app";
import { loadConfig, loadSecrets } from "./config";
import { buildDeps } from "./deps";
import { setLogLevel } from "./log";

const config = loadConfig();
setLogLevel(config.logLevel);
const deps = buildDeps(config);
const honoHandler = handle(createApp(deps));

type Args = Parameters<typeof honoHandler>;

export const handler = async (event: Args[0], context?: Args[1]) => {
  // Cached after the first successful load; deps.secrets is shared with the routes and providers.
  Object.assign(deps.secrets, await loadSecrets(config));
  return honoHandler(event, context);
};
