/**
 * Layout for the long text pages (利用規約・プライバシーポリシー): title, dates, an optional notice
 * of a revision, lead, a table of contents and numbered sections with anchors. Used by TermsPage
 * and PrivacyPage only.
 */
import type { ReactNode } from "react";
import { Link } from "react-router";
import "./InfoPages.css";

export type DocSection = { id: string; title: string; body: ReactNode };

type Props = {
  title: string;
  lead?: ReactNode;
  /** e.g. "制定日 2026年10月6日" */
  meta?: ReactNode;
  /** 改定のお知らせ: what a revision changes and from when (the Terms promise it before that day). */
  notice?: ReactNode;
  sections: readonly DocSection[];
  /** Shown after the sections (dates, contact). */
  footer?: ReactNode;
};

export function InfoDoc({ title, lead, meta, notice, sections, footer }: Props) {
  return (
    <article className="info-page info-doc">
      <header className="info-head">
        <h1 className="info-title">{title}</h1>
        {meta && <p className="info-meta">{meta}</p>}
        {notice && (
          <section className="info-notice" aria-labelledby="revision-notice-h">
            <h2 id="revision-notice-h" className="info-notice-h">
              改定のお知らせ
            </h2>
            {notice}
          </section>
        )}
        {lead && <div className="info-lead">{lead}</div>}
      </header>

      <nav className="info-toc" aria-labelledby="toc-title">
        <h2 id="toc-title" className="info-toc-title">
          目次
        </h2>
        <ol>
          {sections.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`}>{s.title}</a>
            </li>
          ))}
        </ol>
      </nav>

      {sections.map((s, i) => (
        <section key={s.id} id={s.id} className="info-sec" aria-labelledby={`${s.id}-h`}>
          <h2 id={`${s.id}-h`} className="info-h">
            <span className="info-num" aria-hidden="true">
              {i + 1}
            </span>
            {s.title}
          </h2>
          <div className="info-body">{s.body}</div>
        </section>
      ))}

      {footer && <footer className="info-foot">{footer}</footer>}

      <nav className="info-more" aria-label="関連ページ">
        <Link to="/about">このサービスについて</Link>
        <Link to="/terms">利用規約</Link>
        <Link to="/privacy">プライバシーポリシー</Link>
        <Link to="/contact">お問い合わせ</Link>
      </nav>
    </article>
  );
}

/** The operator, as shown on every legal page (no personal name or address on the site). */
export const OPERATOR = "30日だけ 運営事務局（個人運営）";
/** 制定日・改定日・適用日 ("2026年10月6日"); the dates themselves live in lib/legal.ts. */
export { EFFECTIVE, ENACTED, REVISED } from "../lib/legal";
