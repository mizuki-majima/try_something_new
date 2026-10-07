/**
 * The 印 input with a live preview. The value is not cut while typing (an IME composes kanji from
 * several kana first); the shared SealSchema checks "exactly one character" on submit.
 */
import { firstGrapheme } from "@thirty/shared";
import { Field } from "../../components/Field";
import { Seal } from "../../components/Seal";
import "./start.css";

type Props = {
  value: string;
  onChange: (value: string) => void;
  /** Shown in the preview (and as placeholder) while the input is empty, e.g. the title's first character. */
  fallback: string;
  error?: string;
  id?: string;
  label?: string;
};

export function SealField({ value, onChange, fallback, error, id, label = "印（1文字）" }: Props) {
  const preview = firstGrapheme(value) || fallback || "印";
  return (
    <Field label={label} hint="毎日カードに押される1文字です。漢字がおすすめ。空けておくとタイトルの最初の文字になります。" error={error} id={id}>
      {(a) => (
        <div className="st-seal">
          <span className="st-seal-preview" key={preview} aria-hidden="true">
            <Seal char={preview} size="xl" />
          </span>
          <input
            id={a.id}
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={fallback || "印"}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            aria-describedby={a.describedBy}
            aria-invalid={a.invalid || undefined}
          />
        </div>
      )}
    </Field>
  );
}
