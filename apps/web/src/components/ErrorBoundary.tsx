import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorState } from "./States";

type Props = { children: ReactNode };
type State = { error: Error | null };

/** Catches render errors and failed lazy chunks so one broken page never blanks the app. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("render failed", error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <ErrorState
        title="この画面を表示できませんでした"
        message="新しい版が公開されたか、通信が切れた可能性があります。再読み込みしてください。記録はこの端末に残っています。"
        retryLabel="再読み込み"
        onRetry={() => window.location.reload()}
      />
    );
  }
}
