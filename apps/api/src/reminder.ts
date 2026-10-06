/**
 * Lambda "reminder" (EventBridge, every 15 minutes): Web Push to users whose reminder slot is now
 * and who still have an unstamped challenge today (SPEC FR-14).
 * TODO(push): query gsi3 SLOT#<utcSlotOf(now, REMINDER_STEP_MINUTES)>, check challenges, send via deps.push,
 * delete subscriptions that come back `gone`.
 */
import { loadConfig } from "./config";
import { log, setLogLevel } from "./log";

const config = loadConfig();
setLogLevel(config.logLevel);

export const handler = async (): Promise<void> => {
  log.warn("reminder: not implemented");
};
