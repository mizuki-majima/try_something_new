/**
 * Showing a day note in 「みんな」 (#17): the words the note editor, the store and the confirm sheet
 * share, and client-side checks that mirror the API. The API decides again on every request; these
 * only avoid a request that is bound to fail and say why in the editor.
 */
import { StampPutSchema, containsUrl, isPublicNote } from "@thirty/shared";
import { ApiClientError, errorMessage, isQuotaLimit } from "./api";

/** Why showing was refused (the store's result, shown as a toast). */
export const NOTE_SHOW_ERRORS = {
  // The same words as the API's CHALLENGE_MESSAGES.
  noteMissing: "ひとことがある日だけ、みんなに見せられます。",
  noteChanged: "ひとことが変わっていたため、見せませんでした。内容を確かめてから、もう一度選んでください。",
  noteNotNormal: "このひとことは今の決まりに合わないため、見せられません。書き直して保存してから選んでください。",
  progressOff: "進捗の表示がオフのため、見せられません。設定でオンにしてから選んでください。",
  url: "URLが入ったひとことは、みんなに見せられません。",
  limit: "今日はこれ以上、ひとことを見せられません。明日また選べます。",
  offline: "つながっていないため変えられませんでした。つながってからもう一度お試しください。",
  pending: "保存が終わっていません。少し待ってからもう一度お試しください。",
  /** A 404: an API without the route (during a deploy), or a challenge gone on another device. */
  unavailable: "いまは変えられません。少し待ってからもう一度お試しください。",
} as const;

/** The line under the switch (aria-describedby). */
export const NOTE_SHOW_STATUS = {
  empty: "ひとことを書くと、みんなに見せるか選べます。",
  off: "オンにすると、この日のひとことだけが「みんな」に表示されます。",
  on: "「みんな」で誰でも見られます。書き換えると「自分だけ」に戻ります。",
  /** Shown, on a reflected challenge: the note can no longer be edited. */
  onFixed: "「みんな」で誰でも見られます。オフにすると「自分だけ」に戻ります。",
  /** Progress is not shared: the switch cannot be turned on. */
  progressOff: "進捗の表示がオフのあいだは選べません（設定で変えられます）。",
  /** Shown, but progress was turned off later: nobody sees it now (it comes back with progress). */
  shownProgressOff: "進捗の表示がオフなので、いまは誰にも見えていません。",
  /**
   * An edit that makes it private is still queued (AppSnapshot.stillShown): the old text is still seen.
   * Online, turning the switch off takes it back at once (it skips the queue).
   */
  unsent: "送信が終わるまで、前のひとことが「みんな」に見えています。オフにすると、すぐ見えなくなります。",
  /** The same, offline: turning it off needs a connection too. */
  unsentOffline: "送信が終わるまで、前のひとことが「みんな」に見えています。",
  /** Progress turned off here, not sent yet: the note is still seen. */
  unsentProgressOff: "送信が終わるまで、このひとことは「みんな」に見えています。",
  // A note that cannot be shown says why with notShowableReason (e.g. NOTE_SHOW_ERRORS.url).
} as const;

export const NOTE_SHOW_TOASTS = {
  shown: "みんなに見せました",
  hidden: "自分だけに戻しました",
  /** The owner saved another text for a shown note and the server has it: private again (the API does this). */
  reset: "書き換えたので「自分だけ」に戻しました。見せるときは、もう一度選んでください。",
  /** The same, while the edit is still queued (offline, or a retry): the server still shows the old text. */
  resetQueued: "書き換えました。送信が終わると「自分だけ」に戻ります（それまでは前のひとことが見えています）。",
  /**
   * A stamp with a shown note was undone, the undo is still queued, and the note could not be taken
   * back beside it (offline, or that failed too): the server still shows the note.
   */
  unstampQueued: "印を取り消しました。見せていたひとことは、送信が終わるまで「みんな」に見えています。",
} as const;

/** The 「（…）」 after the note field's label: who sees the saved text (#17). */
export function noteFieldSuffix(shown: boolean, progressOn: boolean): string {
  if (!shown) return "（自分だけに見えます）";
  return progressOn ? "（みんなに見せています）" : "（みんなに見せる選択中・進捗の表示はオフ）";
}

/** The line added to 「印を取り消しますか？」 when that day's note is shown. */
export const NOTE_SHOWN_UNSTAMP = "みんなに見せているひとことも消えます。";

/** The note as the API stores it (StampPutSchema's cleaning), or null when it cannot be saved. */
export function cleanNote(text: string): string | null {
  const r = StampPutSchema.safeParse({ note: text });
  return r.success ? (r.data.note ?? "") : null;
}

/** Why this (saved, cleaned) note cannot be shown, or null when it can (isPublicNote, like the API). */
export function notShowableReason(note: string): string | null {
  if (!note) return NOTE_SHOW_ERRORS.noteMissing;
  if (isPublicNote(note)) return null;
  return containsUrl(note) ? NOTE_SHOW_ERRORS.url : NOTE_SHOW_ERRORS.noteNotNormal;
}

/** A failed PUT .../visibility in the words the editor shows. */
export function noteShowErrorMessage(err: unknown): string {
  if (err instanceof ApiClientError) {
    // Only the API's own daily quota: the edge throttle or a refused account creation clears soon.
    if (isQuotaLimit(err)) return NOTE_SHOW_ERRORS.limit;
    if (err.status === 0 && err.code === "network") return NOTE_SHOW_ERRORS.offline;
    if (err.status === 404) return NOTE_SHOW_ERRORS.unavailable;
    if (err.status === 400) return err.fields?.note ?? err.message;
  }
  return errorMessage(err);
}
