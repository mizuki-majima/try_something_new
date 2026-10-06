import { Link } from "react-router";
import { useOnline } from "../lib/hooks";
import { useSync } from "../lib/store";

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
