/**
 * Day notes a member shows in 「みんな」 (#17): 「N日目」 and the text, as a list. The member's details
 * sheet uses it, and so does the sheet that asks before a note is shown (as its preview), so the
 * owner sees exactly what others will. Plain text only: React escapes it and nothing becomes a link.
 */
import type { MemberNote } from "@thirty/shared";
import "./MemberNotes.css";

export function MemberNoteList({ notes }: { notes: readonly MemberNote[] }) {
  return (
    <ol className="mn-list">
      {notes.map((n) => (
        <li key={n.day} className="mn-item">
          <b className="mn-day">{n.day}日目</b>
          <p className="mn-text">{n.note}</p>
        </li>
      ))}
    </ol>
  );
}
