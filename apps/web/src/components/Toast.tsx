import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type ToastTone = "info" | "error";
export type ToastOptions = { tone?: ToastTone; durationMs?: number };
type ToastFn = (message: string, opts?: ToastOptions) => void;
type ToastItem = { id: number; message: string; tone: ToastTone };

const ToastApi = createContext<ToastFn | null>(null);
const ToastState = createContext<ToastItem | null>(null);

const noop: ToastFn = () => {};

/** Holds the current toast. Render <ToastHost /> once inside it (the Layout does). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<ToastItem | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seq = useRef(0);

  const show = useCallback<ToastFn>((message, opts) => {
    const tone = opts?.tone ?? "info";
    const id = ++seq.current;
    setCurrent({ id, message, tone });
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setCurrent((c) => (c?.id === id ? null : c)),
      opts?.durationMs ?? (tone === "error" ? 4500 : 2600),
    );
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <ToastApi.Provider value={show}>
      <ToastState.Provider value={current}>{children}</ToastState.Provider>
    </ToastApi.Provider>
  );
}

/** toast("保存しました") / toast("送れませんでした", { tone: "error" }). Stable identity. */
export function useToast(): ToastFn {
  return useContext(ToastApi) ?? noop;
}

/** The live region. Always mounted so screen readers announce changes. */
export function ToastHost() {
  const current = useContext(ToastState);
  const key = useMemo(() => current?.id ?? 0, [current]);
  return (
    <div className="toast-host" role="status" aria-live="polite" aria-atomic="true">
      {current && (
        <div key={key} className={current.tone === "error" ? "toast error" : "toast"}>
          {current.message}
        </div>
      )}
    </div>
  );
}
