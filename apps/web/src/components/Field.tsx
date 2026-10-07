/**
 * Form fields: label + control + hint / error + a character counter that counts graphemes
 * (the same unit the API validates with: an emoji or a kanji with a variation selector is one).
 *
 *   <TextField label="ニックネーム" value={nick} onChange={setNick} max={LIMITS.nickname} error={errors.nickname} />
 *   <Field label="開始日">{(a) => <select id={a.id} aria-describedby={a.describedBy} aria-invalid={a.invalid}>…</select>}</Field>
 */
import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { graphemeLength } from "@thirty/shared";

export type FieldA11y = { id: string; describedBy: string | undefined; invalid: boolean };

type FieldProps = {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | undefined;
  /** Shows "n/max" counted in graphemes. */
  count?: { value: string; max: number };
  children: (a11y: FieldA11y) => ReactNode;
  className?: string;
  id?: string;
};

export function Field({ label, hint, error, count, children, className, id: idProp }: FieldProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const countId = count ? `${id}-count` : undefined;
  const describedBy = [errId, hintId, countId].filter(Boolean).join(" ") || undefined;
  const n = count ? graphemeLength(count.value) : 0;
  const over = count ? n > count.max : false;
  return (
    <div className={className ? `field ${className}` : "field"}>
      <label htmlFor={id}>{label}</label>
      {children({ id, describedBy, invalid: Boolean(error) || over })}
      {(hint || error || count) && (
        <div className="field-foot">
          <div className="stack" style={{ gap: 2 }}>
            {error && (
              <span className="field-err" id={errId}>
                {error}
              </span>
            )}
            {hint && (
              <span className="field-hint" id={hintId}>
                {hint}
              </span>
            )}
          </div>
          {count && (
            <span className={over ? "counter over" : "counter"} id={countId}>
              <span aria-hidden="true">
                {n}/{count.max}
              </span>
              <span className="sr-only">
                {count.max}文字中{n}文字
              </span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

type Common = { label: ReactNode; hint?: ReactNode; error?: string | undefined; value: string; onChange: (value: string) => void };

export type TextFieldProps = Common &
  Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "id" | "max"> & {
    /** Grapheme limit; shows the counter. */
    max?: number;
    id?: string;
  };

export function TextField({ label, hint, error, value, onChange, max, id, className, type = "text", ...rest }: TextFieldProps) {
  return (
    <Field label={label} hint={hint} error={error} count={max ? { value, max } : undefined} className={className} id={id}>
      {(a) => (
        <input
          {...rest}
          id={a.id}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={a.describedBy}
          aria-invalid={a.invalid || undefined}
        />
      )}
    </Field>
  );
}

export type TextAreaFieldProps = Common &
  Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange" | "id"> & { max?: number; id?: string };

export function TextAreaField({ label, hint, error, value, onChange, max, id, className, rows = 3, ...rest }: TextAreaFieldProps) {
  return (
    <Field label={label} hint={hint} error={error} count={max ? { value, max } : undefined} className={className} id={id}>
      {(a) => (
        <textarea
          {...rest}
          id={a.id}
          rows={rows}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={a.describedBy}
          aria-invalid={a.invalid || undefined}
        />
      )}
    </Field>
  );
}

export type SelectFieldProps = Common &
  Omit<SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange" | "id"> & {
    options: readonly { value: string; label: string }[];
    id?: string;
  };

export function SelectField({ label, hint, error, value, onChange, options, id, className, ...rest }: SelectFieldProps) {
  return (
    <Field label={label} hint={hint} error={error} className={className} id={id}>
      {(a) => (
        <select
          {...rest}
          id={a.id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={a.describedBy}
          aria-invalid={a.invalid || undefined}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}
