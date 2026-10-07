import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useOnline } from "../lib/hooks";
import { useSync, type Throttle } from "../lib/store";

/** Top band while the device is offline (SPEC: "オフライン時は上部に帯を出す"). */
export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div className="band" role="status">
      オフラインです。記録はこの端末に保存され、つながったら送ります。
    </div>
  );
}

/** After a 401 the token is gone: explain and point to recovery (transfer code / start over). */
export function SessionBanner() {
  const { sessionInvalid } = useSync();
  if (!sessionInvalid) return null;
  return (
    <div className="band warn" role="alert">
      この端末の記録をサーバーで確認できませんでした。<Link to="/settings#transfer">引き継ぎコードで復元</Link>
      するか、設定から新しく始められます。
    </div>
  );
}

/** "約12分後に自動で送ります" for a wait that ends at `until`. */
export function resumeText(until: number, now: number): string {
  const minutes = Math.ceil((until - now) / 60_000);
  return minutes <= 1 ? "まもなく自動で送ります" : `約${minutes}分後に自動で送ります`;
}

function ThrottleBand({ throttle }: { throttle: Throttle }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="band" role="status" data-testid="throttle-band">
      {throttle.reason}
      {resumeText(throttle.until, now)}。記録はこの端末に保存されています。
    </div>
  );
}

/**
 * The server asked us to wait (a 429 on the queue, or on creating the account: new accounts are
 * limited per network and overall). SPEC "Error Handling" 429: say why and when it resumes, on
 * screen — the sync pill's tooltip never shows on phones.
 */
export function ThrottleBanner() {
  const { status, throttle } = useSync();
  if (status !== "waiting" || !throttle) return null;
  return <ThrottleBand key={throttle.until} throttle={throttle} />;
}
