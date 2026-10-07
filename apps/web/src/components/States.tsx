/** Loading / empty / error states. Every screen shows one of these instead of a blank area. */
import type { ReactNode } from "react";
import { Seal } from "./Seal";

export function Loading({ label = "読み込んでいます…", inline = false }: { label?: string; inline?: boolean }) {
  return (
    <div className={inline ? "loading inline" : "loading"} role="status" aria-live="polite">
      <span className="dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>{label}</span>
    </div>
  );
}

type EmptyProps = {
  title: string;
  children?: ReactNode;
  /** Buttons / links. */
  action?: ReactNode;
  seal?: string;
};

export function EmptyState({ title, children, action, seal }: EmptyProps) {
  return (
    <div className="empty">
      {seal && <Seal char={seal} size="lg" />}
      <b>{title}</b>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

type ErrorProps = {
  message: string;
  title?: string;
  onRetry?: () => void;
  retryLabel?: string;
  retrying?: boolean;
};

export function ErrorState({ message, title = "読み込めませんでした", onRetry, retryLabel = "再試行", retrying = false }: ErrorProps) {
  return (
    <div className="errorbox" role="alert">
      <b>{title}</b>
      <p>{message}</p>
      {onRetry && (
        <button type="button" className="btn sm" onClick={onRetry} disabled={retrying}>
          {retrying ? "読み込んでいます…" : retryLabel}
        </button>
      )}
    </div>
  );
}
