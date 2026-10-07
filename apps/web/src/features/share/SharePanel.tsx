/**
 * The share step of the reflection (FR-7, CUF-2): preview of the 1200×630 card and every way to
 * pass it on. Device-only actions (save, Web Share, X) keep working when the upload fails.
 */
import { useEffect, useId, useMemo, useState } from "react";
import type { Challenge } from "@thirty/shared";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { CopyIcon, DownloadIcon, LinkIcon, ShareIcon } from "../../components/Icons";
import { ErrorState, Loading } from "../../components/States";
import { useToast } from "../../components/Toast";
import { errorMessage } from "../../lib/api";
import { useAppActions } from "../../lib/store";
import { renderShareCard, shareCardAlt, shareCardData, type ShareCardData } from "./shareCard";
import {
  cardFileName,
  createShareLink,
  deleteShareLink,
  lineShareUrl,
  publicShareUrl,
  shareText,
  trackShare,
  xIntentUrl,
} from "./shareActions";
import "./share.css";

type Props = {
  challenge: Challenge;
  /** The verdict or ひとこと changed after the current public link was made. */
  linkOutdated?: boolean;
  /** Called after a new link was created (the parent clears linkOutdated). */
  onLinkCreated?: () => void;
};

type CardState = { key: string; blob: Blob; url: string } | { key: string; error: true } | null;
type LinkOverride = { id: string; url: string } | null | undefined;

function canShareFile(file: File | null): boolean {
  if (!file || typeof navigator === "undefined" || typeof navigator.share !== "function" || typeof navigator.canShare !== "function") return false;
  try {
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

export function SharePanel({ challenge, linkOutdated = false, onLinkCreated }: Props) {
  const { flush, refresh } = useAppActions();
  const toast = useToast();
  const linkHelpId = useId();

  // Redraw only when what is on the card changes (not on every sync of the challenge).
  const key = JSON.stringify(shareCardData(challenge));
  const data = useMemo(() => JSON.parse(key) as ShareCardData, [key]);
  const [attempt, setAttempt] = useState(0);
  const [card, setCard] = useState<CardState>(null);

  useEffect(() => {
    let cancelled = false;
    renderShareCard(data).then(
      (blob) => {
        if (!cancelled) setCard({ key, blob, url: URL.createObjectURL(blob) });
      },
      (err: unknown) => {
        console.warn("share card", err);
        if (!cancelled) setCard({ key, error: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [data, key, attempt]);

  // Each preview URL is released when it is replaced or the panel unmounts.
  const previewUrl = card && "url" in card ? card.url : null;
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  const ready = card && card.key === key && "blob" in card ? card : null;
  const failed = card && card.key === key && "error" in card;
  const fileName = cardFileName(challenge.seal);
  const file = useMemo(() => (ready ? new File([ready.blob], fileName, { type: "image/png" }) : null), [ready, fileName]);
  const webShare = canShareFile(file);

  const [link, setLink] = useState<LinkOverride>(undefined);
  const linkId = link === undefined ? challenge.shareId : (link?.id ?? null);
  const linkUrl = link === undefined ? (challenge.shareId ? publicShareUrl(challenge.shareId) : null) : (link?.url ?? null);
  const [busy, setBusy] = useState<"creating" | "deleting" | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);

  const text = shareText({ title: challenge.title, count: data.count, verdict: challenge.verdict, reflection: challenge.reflection });

  async function onWebShare() {
    if (!file) return;
    trackShare("webshare");
    try {
      await navigator.share({ files: [file], title: "30日だけ", text: linkUrl ? `${text}\n${linkUrl}` : text });
    } catch (err) {
      if ((err as { name?: string } | null)?.name !== "AbortError") toast("共有できませんでした。画像を保存して送ってください。", { tone: "error" });
    }
  }

  async function onCreateLink() {
    if (!ready || busy) return;
    setBusy("creating");
    setLinkError(null);
    try {
      await flush(); // the reflection must be on the server before the card can be published
      const res = await createShareLink(challenge.id, ready.blob);
      setLink({ id: res.id, url: res.url });
      setCopied(false);
      trackShare("link");
      onLinkCreated?.();
      void refresh();
    } catch (err) {
      setLinkError(errorMessage(err, "リンクを作れませんでした。"));
    } finally {
      setBusy(null);
    }
  }

  async function onDeleteLink() {
    if (!linkId) return;
    setBusy("deleting");
    setLinkError(null);
    try {
      await deleteShareLink(linkId);
      setLink(null);
      setConfirmDelete(false);
      toast("公開リンクを削除しました");
      void refresh();
    } catch (err) {
      setConfirmDelete(false);
      setLinkError(errorMessage(err, "リンクを削除できませんでした。"));
    } finally {
      setBusy(null);
    }
  }

  async function onCopy() {
    if (!linkUrl) return;
    trackShare("copy");
    try {
      await navigator.clipboard.writeText(linkUrl);
      setCopied(true);
    } catch {
      toast("コピーできませんでした。リンクを長押しして選んでください。", { tone: "error" });
    }
  }

  return (
    <div className="sh-page">
      <div className="sh-preview">
        {ready ? (
          <img className="sh-img" src={ready.url} alt={shareCardAlt(data)} width={1200} height={630} />
        ) : failed ? (
          <ErrorState title="カードを作れませんでした" message="この端末で画像を描けませんでした。もう一度お試しください。" onRetry={() => setAttempt((n) => n + 1)} />
        ) : (
          <div className="sh-drawing">
            <Loading label="カードを描いています…" />
          </div>
        )}
      </div>

      <div className="sh-actions" role="group" aria-label="共有する">
        {ready ? (
          <a className="btn primary sh-btn" href={ready.url} download={fileName} onClick={() => trackShare("image")}>
            <DownloadIcon />
            画像を保存
          </a>
        ) : (
          <button type="button" className="btn primary sh-btn" disabled>
            <DownloadIcon />
            画像を保存
          </button>
        )}
        {webShare && (
          <button type="button" className="btn sh-btn" onClick={() => void onWebShare()}>
            <ShareIcon />
            共有
          </button>
        )}
        <a className="btn sh-btn sh-x" href={xIntentUrl(text, linkUrl)} target="_blank" rel="noopener noreferrer" onClick={() => trackShare("x")}>
          Xで共有<span className="sr-only">（新しいタブで開きます）</span>
        </a>
        {linkUrl ? (
          <a className="btn sh-btn sh-line" href={lineShareUrl(linkUrl)} target="_blank" rel="noopener noreferrer" onClick={() => trackShare("line")}>
            LINEで送る<span className="sr-only">（新しいタブで開きます）</span>
          </a>
        ) : (
          <button type="button" className="btn sh-btn sh-line" disabled aria-describedby={linkHelpId}>
            LINEで送る
          </button>
        )}
      </div>
      {!linkUrl && (
        <p className="note" id={linkHelpId}>
          LINEで送るには、下の「リンクを作って共有」で公開リンクを作ってください。
        </p>
      )}

      <section className="sh-link" aria-labelledby={`${linkHelpId}-h`}>
        <h3 className="sh-link-h" id={`${linkHelpId}-h`}>
          <LinkIcon />
          公開リンク
        </h3>
        <p className="note">
          リンクを知っている人なら誰でも、このカードの画像・ニックネーム・タイトル・印・判定・ひとことを見られます。日ごとのメモや写真は載りません。リンクはいつでも削除できます。
        </p>
        {linkUrl ? (
          <>
            <div className="sh-url">
              <label className="sr-only" htmlFor={`${linkHelpId}-url`}>
                公開リンク
              </label>
              <input id={`${linkHelpId}-url`} type="text" readOnly value={linkUrl} onFocus={(e) => e.currentTarget.select()} />
              <button type="button" className="btn sh-btn" onClick={() => void onCopy()}>
                <CopyIcon />
                コピー
              </button>
            </div>
            <p className="note" role="status" aria-live="polite">
              {copied ? "コピーしました" : ""}
            </p>
            {linkOutdated && (
              <div className="sh-outdated">
                <p>公開中のカードは、前の判定・ひとことのままです。</p>
                <button type="button" className="btn sm" onClick={() => void onCreateLink()} disabled={!ready || busy !== null} aria-busy={busy === "creating"}>
                  {busy === "creating" ? "作り直しています…" : "リンクを作り直す"}
                </button>
              </div>
            )}
            <button type="button" className="linkbtn danger sh-del" onClick={() => setConfirmDelete(true)} disabled={busy !== null}>
              リンクを削除
            </button>
          </>
        ) : (
          <button type="button" className="btn lg sh-make" onClick={() => void onCreateLink()} disabled={!ready || busy !== null} aria-busy={busy === "creating"}>
            {busy === "creating" ? "リンクを作っています…" : "リンクを作って共有"}
          </button>
        )}
        {linkError && (
          <p className="sh-err" role="alert">
            {linkError}
            <br />
            画像の保存やXでの共有は、このまま使えます。
          </p>
        )}
      </section>

      <ConfirmDialog
        open={confirmDelete}
        title="公開リンクを削除しますか？"
        message="リンクを開いても、カードは表示されなくなります。記録そのものは消えません。"
        confirmLabel="削除する"
        danger
        busy={busy === "deleting"}
        onConfirm={() => void onDeleteLink()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
