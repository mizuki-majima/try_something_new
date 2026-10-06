const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** 16-char random id from the platform CSPRNG (browser and Node 22 both expose globalThis.crypto). */
export function newId(length = 16): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  // 252 = 7 * 36: reject values above it so every character is uniformly likely.
  for (let i = 0; out.length < length; i++) {
    if (i >= bytes.length) {
      crypto.getRandomValues(bytes);
      i = 0;
    }
    const b = bytes[i]!;
    if (b < 252) out += ALPHABET[b % 36];
  }
  return out;
}
