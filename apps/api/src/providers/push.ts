import type { Config, Secrets } from "../config";
import { log } from "../log";
import type { PushSender, PushTarget } from "../ports";

/** Accepts every message without sending anything. Used until the Web Push sender exists, and in tests. */
export class NoopPushSender implements PushSender {
  readonly sent: { sub: PushTarget; payload: object }[] = [];

  async send(sub: PushTarget, payload: object): Promise<{ ok: boolean; gone: boolean }> {
    this.sent.push({ sub, payload });
    return { ok: true, gone: false };
  }
}

/**
 * Hook for the Web Push (VAPID) sender.
 * `secrets` is the same object as Deps.secrets; on Lambda it is filled in place when the first
 * request arrives, so read secrets.vapidPrivateKey at send time, not here.
 * TODO(push): build a web-push based sender from config.vapidPublicKey / secrets.vapidPrivateKey / config.vapidSubject.
 */
export function createPushSender(_config: Config, _secrets: Secrets): PushSender {
  log.debug("push: using no-op sender");
  return new NoopPushSender();
}
