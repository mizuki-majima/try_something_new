/**
 * お問い合わせ (SPEC FR-19). Works without an account (the API uses the token only when there is one).
 *
 * /contact?report=share:<id> is the 「通報」 for a public card (FR-18): /s/:id is script-free server
 * HTML, so its 「このカードを通報する」 link lands here and this page shows a report form for that
 * card instead of the contact form.
 */
import { useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { API, ContactCreateSchema, ID_RE, LIMITS, QUOTAS, ReportCreateSchema, type ContactCreate } from "@thirty/shared";
import { TextAreaField, TextField } from "../components/Field";
import { reportErrorMessage } from "../components/ReportButton";
import { Seal } from "../components/Seal";
import { ApiClientError, errorMessage, isQuotaLimit, request } from "../lib/api";
import { usePageTitle } from "../lib/hooks";
import { AUTO_HIDE_CONDITION, REPORT_REVIEWED } from "../lib/reportCopy";
import { parseWith } from "../lib/validation";
import "./InfoPages.css";

type Status = "editing" | "sending" | "sent";

/** The share id from `?report=share:<id>`, or null when the query is absent or malformed. */
export function reportedShareId(param: string | null): string | null {
  const m = /^share:(.+)$/.exec(param ?? "");
  return m && ID_RE.test(m[1]!) ? m[1]! : null;
}

export default function ContactPage() {
  const [params] = useSearchParams();
  const shareId = reportedShareId(params.get("report"));
  return shareId ? <ShareReport shareId={shareId} /> : <ContactForm />;
}

function ContactForm() {
  usePageTitle("お問い合わせ");
  const [message, setMessage] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("editing");
  const headingRef = useRef<HTMLHeadingElement>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const input: ContactCreate = replyTo.trim() ? { message, replyTo } : { message };
    const parsed = parseWith(ContactCreateSchema, input);
    if (!parsed.ok) {
      setErrors(parsed.fields);
      document.getElementById(parsed.fields.message ? "contact-message" : "contact-reply")?.focus();
      return;
    }
    setErrors({});
    setStatus("sending");
    try {
      const body: ContactCreate = parsed.data.replyTo ? parsed.data : { message: parsed.data.message };
      await request("POST", API.contact, { body, auth: "optional" });
      setStatus("sent");
      setMessage("");
      setReplyTo("");
      requestAnimationFrame(() => headingRef.current?.focus());
    } catch (err) {
      setStatus("editing");
      if (isQuotaLimit(err)) {
        setFormError(`お問い合わせは1日${QUOTAS.contactPerUserPerDay}件までです。明日、もう一度お送りください。`);
      } else if (err instanceof ApiClientError && err.fields) {
        setErrors(err.fields);
        setFormError(err.message);
      } else {
        setFormError(`送れませんでした。${errorMessage(err)}`);
      }
    }
  }

  if (status === "sent") {
    return (
      <article className="info-page contact">
        <div className="contact-done">
          <Seal char="済" size="xl" />
          <h1 className="info-title" tabIndex={-1} ref={headingRef}>
            送信しました
          </h1>
          <p>お問い合わせありがとうございます。いただいた内容は、運営者が順に読んでいます。</p>
          <p className="note">返信先を書いていただいた場合でも、すべてにお返事できるとは限りません。ご了承ください。</p>
          <div className="row gap fw contact-done-actions">
            <button type="button" className="btn" onClick={() => setStatus("editing")}>
              もう1件送る
            </button>
            <Link to="/" className="btn primary">
              きょうに戻る
            </Link>
          </div>
        </div>
      </article>
    );
  }

  const sending = status === "sending";
  return (
    <article className="info-page contact">
      <header className="info-head">
        <h1 className="info-title">お問い合わせ</h1>
        <div className="info-lead">
          <p>ご意見、不具合の報告、削除のご依頼などはこちらから。ログインやメールアドレスの登録はいりません。</p>
        </div>
      </header>

      <p className="contact-report">
        投稿の削除依頼は各投稿の『通報』からもできます。<Link to="/terms#report">通報と削除について</Link>
      </p>

      <form className="form card contact-form" onSubmit={(e) => void onSubmit(e)} noValidate aria-busy={sending}>
        <TextAreaField
          id="contact-message"
          label="お問い合わせ内容"
          value={message}
          onChange={(v) => {
            setMessage(v);
            if (errors.message) setErrors((x) => ({ ...x, message: "" }));
          }}
          max={LIMITS.contactMessage}
          rows={8}
          required
          error={errors.message || undefined}
          hint="削除のご依頼は、対象のページの URL と理由を書いてください。"
          disabled={sending}
        />
        <TextField
          id="contact-reply"
          label="返信先（任意）"
          value={replyTo}
          onChange={(v) => {
            setReplyTo(v);
            if (errors.replyTo) setErrors((x) => ({ ...x, replyTo: "" }));
          }}
          max={LIMITS.contactReplyTo}
          error={errors.replyTo || undefined}
          hint="返信が必要な場合だけ。書いたものは返信のためだけに使い、180日で削除します"
          autoComplete="off"
          disabled={sending}
        />
        <div aria-live="polite">
          {formError && (
            <p className="note err" role="alert">
              {formError}
            </p>
          )}
        </div>
        <button type="submit" className="btn primary lg" disabled={sending} aria-busy={sending}>
          {sending ? "送っています…" : "送信する"}
        </button>
        <p className="note">
          お問い合わせの内容と返信先は180日で削除します。扱いについては<Link to="/privacy">プライバシーポリシー</Link>をご覧ください。
        </p>
      </form>
    </article>
  );
}

/** 「通報」 for the public card /s/<shareId> (FR-18). Creates the anonymous account if needed. */
function ShareReport({ shareId }: { shareId: string }) {
  usePageTitle("カードを通報する");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("editing");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const cardPath = `/s/${shareId}`;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (status === "sending") return;
    const trimmed = reason.trim();
    const parsed = parseWith(ReportCreateSchema, { targetType: "share", targetId: shareId, ...(trimmed ? { reason: trimmed } : {}) });
    if (!parsed.ok) {
      setError(parsed.fields.reason ?? parsed.message);
      return;
    }
    setError(null);
    setStatus("sending");
    try {
      await request<void>("POST", API.reports, { body: parsed.data, auth: "required" });
      setStatus("sent");
      setReason("");
      requestAnimationFrame(() => headingRef.current?.focus());
    } catch (err) {
      setStatus("editing");
      setError(reportErrorMessage(err));
    }
  }

  // /s/:id is served by the API, not the app: a full page load (the SW never answers it).
  const back = (
    <a href={cardPath} className="btn">
      カードに戻る
    </a>
  );

  if (status === "sent") {
    return (
      <article className="info-page contact">
        <div className="contact-done">
          <Seal char="済" size="xl" />
          <h1 className="info-title" tabIndex={-1} ref={headingRef}>
            通報しました
          </h1>
          <p>ありがとうございます。運営者が内容を確かめて、必要なら非表示にします。</p>
          <div className="row gap fw contact-done-actions">
            {back}
            <Link to="/" className="btn primary">
              きょうに戻る
            </Link>
          </div>
        </div>
      </article>
    );
  }

  const sending = status === "sending";
  return (
    <article className="info-page contact">
      <header className="info-head">
        <h1 className="info-title">カードを通報する</h1>
        <div className="info-lead">
          <p>
            公開カード <a href={cardPath}>{cardPath}</a> を運営者に知らせます。{REPORT_REVIEWED}
            {AUTO_HIDE_CONDITION}
          </p>
        </div>
      </header>

      <form className="form card contact-form" onSubmit={(e) => void onSubmit(e)} noValidate aria-busy={sending}>
        <TextAreaField
          id="report-reason"
          label="理由（任意）"
          value={reason}
          onChange={(v) => {
            setReason(v);
            if (error) setError(null);
          }}
          max={LIMITS.reportReason}
          rows={4}
          placeholder="例：人を傷つける内容です"
          disabled={sending}
        />
        <div aria-live="polite">
          {error && (
            <p className="note err" role="alert">
              {error}
            </p>
          )}
        </div>
        <button type="submit" className="btn primary lg" disabled={sending} aria-busy={sending}>
          {sending ? "送信中…" : "送信"}
        </button>
        <div className="row gap fw">
          {back}
          <Link to="/contact" className="btn ghost">
            お問い合わせフォームへ
          </Link>
        </div>
        <p className="note">
          通報の扱いは<Link to="/terms#report">利用規約</Link>と<Link to="/privacy">プライバシーポリシー</Link>をご覧ください。
        </p>
      </form>
    </article>
  );
}
