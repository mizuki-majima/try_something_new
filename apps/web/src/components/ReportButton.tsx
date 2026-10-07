/**
 * "通報" (SPEC FR-18): a small text button that opens a sheet with an optional reason and sends
 * POST /api/reports. The operator reads every report; only some reporters count towards hiding an
 * item automatically (reportCopy.ts), so the sheet does not promise it.
 *
 *   <ReportButton targetType="story" targetId={`${recipeId}:${storyId}`} subject="みずさんの体験談" />
 */
import { useState, type FormEvent } from "react";
import { API, LIMITS, ReportCreateSchema, type ReportTargetType } from "@thirty/shared";
import { ApiClientError, errorMessage, isQuotaLimit, request } from "../lib/api";
import { AUTO_HIDE_CONDITION, REPORT_REVIEWED } from "../lib/reportCopy";
import { parseWith } from "../lib/validation";
import { TextAreaField } from "./Field";
import { Sheet } from "./Sheet";
import { useToast } from "./Toast";
import "./ReportButton.css";

type Props = {
  targetType: ReportTargetType;
  /** recipe: recipeId / story: "<recipeId>:<storyId>" / share: shareId / member: challengeId */
  targetId: string;
  /** What is reported, for the accessible name and the sheet ("みずさんの体験談"). */
  subject?: string;
  className?: string;
};

const SUBJECTS: Record<ReportTargetType, string> = {
  recipe: "このレシピ",
  story: "この体験談",
  share: "このカード",
  member: "この表示",
};

export function reportErrorMessage(err: unknown): string {
  if (err instanceof ApiClientError) {
    // Only the report quota itself: a refused account creation or the edge throttle clears soon.
    if (isQuotaLimit(err)) return "今日の通報はここまでです。明日また送れます。";
    if (err.status === 400) return err.fields?.reason ?? err.message;
    if (err.status === 404) return "通報する対象が見つかりませんでした。すでに削除された可能性があります。";
  }
  return errorMessage(err);
}

export function ReportButton({ targetType, targetId, subject, className }: Props) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const what = subject ?? SUBJECTS[targetType];

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const trimmed = reason.trim();
    const parsed = parseWith(ReportCreateSchema, { targetType, targetId, ...(trimmed ? { reason: trimmed } : {}) });
    if (!parsed.ok) {
      setError(parsed.fields.reason ?? parsed.message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await request<void>("POST", API.reports, { body: parsed.data, auth: "required" });
      setSent(true);
      setOpen(false);
      setReason("");
      toast("通報しました。ありがとうございます");
    } catch (err) {
      setError(reportErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <span className={className ? `report-done ${className}` : "report-done"} role="status">
        通報済み
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        className={className ? `linkbtn report-btn ${className}` : "linkbtn report-btn"}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        aria-haspopup="dialog"
      >
        通報<span className="sr-only">（{what}）</span>
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="通報する" dismissible={!busy}>
        <form className="form" onSubmit={submit} noValidate>
          <p className="note">
            {what}を運営者に知らせます。{REPORT_REVIEWED}
            {AUTO_HIDE_CONDITION}
          </p>
          <TextAreaField
            label="理由（任意）"
            value={reason}
            onChange={setReason}
            max={LIMITS.reportReason}
            rows={3}
            placeholder="例：人を傷つける内容です"
          />
          {error && (
            <p className="note err" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn ghost" onClick={() => setOpen(false)} disabled={busy}>
              やめる
            </button>
            <button type="submit" className="btn primary" disabled={busy} aria-busy={busy}>
              {busy ? "送信中…" : "送信"}
            </button>
          </div>
        </form>
      </Sheet>
    </>
  );
}
