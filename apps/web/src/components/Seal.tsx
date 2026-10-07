/** The 朱 seal: one ink character on a vermilion disc with an ink ring and hard shadow, tilted -6deg. */
export type SealSize = "sm" | "md" | "lg" | "xl";

type Props = {
  char: string;
  size?: SealSize;
  /** For use on the 朱 primary button (a yellow seal with an ink ring). */
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
