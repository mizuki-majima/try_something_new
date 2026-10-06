import { VERDICTS, type Verdict } from "@thirty/shared";
import "./share.css";

/** 判定ステッカー (shared .badge): 続ける=mint, やめる=gray, 形を変える=blue (docs/design.md). */
export function VerdictBadge({ verdict, size = "md" }: { verdict: Verdict; size?: "md" | "lg" }) {
  return <span className={`badge ${verdict}${size === "lg" ? " vbadge-lg" : ""}`}>{VERDICTS[verdict].label}</span>;
}
