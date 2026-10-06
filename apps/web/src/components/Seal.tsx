/** The 朱 seal: one character in a slightly rotated vermilion ring. */
export type SealSize = "sm" | "md" | "lg" | "xl";

type Props = {
  char: string;
  size?: SealSize;
  /** White ring for use on the vermilion primary button. */
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
