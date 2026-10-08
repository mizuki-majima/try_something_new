/** The 朱 seal: a 朱 ring with one handwritten 朱 character, no fill, tilted -4deg (components.css .seal). */
export type SealSize = "sm" | "md" | "lg" | "xl";

type Props = {
  char: string;
  size?: SealSize;
  /** For use on the green primary button (ring and character in the button's text colour). */
  inverse?: boolean;
  /** Accessible name (e.g. "印「写」"). Without it the seal is decorative. */
  label?: string;
  className?: string;
};

export function Seal({ char, size = "md", inverse = false, label, className }: Props) {
  const cls = ["seal", size !== "md" ? size : "", inverse ? "inv" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <span className={cls} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {char || "印"}
    </span>
  );
}
