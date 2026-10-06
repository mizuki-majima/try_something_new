/** お問い合わせ (SPEC FR-19). Works without an account (the API uses the token only when there is one). */
import { useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { API, ContactCreateSchema, LIMITS, QUOTAS, type ContactCreate } from "@thirty/shared";
import { TextAreaField, TextField } from "../components/Field";
import { Seal } from "../components/Seal";
import { ApiClientError, errorMessage, request } from "../lib/api";
import { usePageTitle } from "../lib/hooks";
import { parseWith } from "../lib/validation";
import "./InfoPages.css";

type Status = "editing" | "sending" | "sent";

export default function ContactPage() {
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
      if (err instanceof ApiClientError && err.status === 429) {
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
          <p className="note">連絡先を書いていただいた場合でも、すべてにお返事できるとは限りません。ご了承ください。</p>
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
          label="連絡先（任意）"
          value={replyTo}
          onChange={(v) => {
            setReplyTo(v);
            if (errors.replyTo) setErrors((x) => ({ ...x, replyTo: "" }));
          }}
          max={LIMITS.contactReplyTo}
          error={errors.replyTo || undefined}
          hint="返信が必要な場合だけ。メールアドレス等を書いた場合は返信のためだけに使います"
          autoComplete="email"
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
          お問い合わせの内容は180日で削除します。扱いについては<Link to="/privacy">プライバシーポリシー</Link>をご覧ください。
        </p>
      </form>
    </article>
  );
}
