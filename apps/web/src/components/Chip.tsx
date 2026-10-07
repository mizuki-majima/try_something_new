/**
 * Chips. ChipGroup is a single-choice radio group (arrow keys move and select, one tab stop);
 * Chip alone is a toggle button.
 */
import { useRef, type KeyboardEvent, type ReactNode } from "react";

export type ChipOption<T extends string> = { value: T; label: ReactNode; disabled?: boolean };

type GroupProps<T extends string> = {
  /** Accessible name of the group (or use labelledBy). */
  label?: string;
  labelledBy?: string;
  value: T;
  options: readonly ChipOption<T>[];
  onChange: (value: T) => void;
  className?: string;
};

export function ChipGroup<T extends string>({ label, labelledBy, value, options, onChange, className }: GroupProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIndex = options.findIndex((o) => o.value === value);
  const focusIndex = selectedIndex >= 0 ? selectedIndex : options.findIndex((o) => !o.disabled);

  function move(from: number, step: 1 | -1 | "first" | "last") {
    const n = options.length;
    const order =
      step === "first"
        ? options.map((_, i) => i)
        : step === "last"
          ? options.map((_, i) => n - 1 - i)
          : Array.from({ length: n - 1 }, (_, k) => (from + step * (k + 1) + n * 2) % n);
    const next = order.find((i) => !options[i]?.disabled);
    if (next === undefined) return;
    refs.current[next]?.focus();
    onChange(options[next]!.value);
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const keys: Record<string, 1 | -1 | "first" | "last"> = {
      ArrowRight: 1,
      ArrowDown: 1,
      ArrowLeft: -1,
      ArrowUp: -1,
      Home: "first",
      End: "last",
    };
    const step = keys[e.key];
    if (step === undefined) return;
    e.preventDefault();
    move(index, step);
  }

  return (
    <div
      role="radiogroup"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      className={className ? `chips ${className}` : "chips"}
    >
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={i === focusIndex ? 0 : -1}
            disabled={o.disabled}
            className="chip"
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

type ChipProps = {
  pressed: boolean;
  onToggle: () => void;
  children: ReactNode;
  disabled?: boolean;
};

export function Chip({ pressed, onToggle, children, disabled }: ChipProps) {
  return (
    <button type="button" className="chip" aria-pressed={pressed} disabled={disabled} onClick={onToggle} data-on={pressed || undefined}>
      {children}
    </button>
  );
}
