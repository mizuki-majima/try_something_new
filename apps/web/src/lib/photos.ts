/**
 * Per-day photos, stored ONLY on this device (IndexedDB), never uploaded (SPEC FR-5).
 * OWNER: the "today/challenge/reflect/log" page developer. Typed placeholder so Settings can call
 * clearAllPhotos() after account deletion; keep the signatures stable.
 */

/** Resize/re-encode (drops EXIF/location) and store the photo for one day of a challenge. */
export async function savePhoto(_challengeId: string, _day: number, _file: Blob): Promise<void> {
  throw new Error("not implemented");
}

/** Object URL for the stored photo, or null. Caller revokes it. */
export async function getPhotoUrl(_challengeId: string, _day: number): Promise<string | null> {
  return null;
}

export async function deletePhoto(_challengeId: string, _day: number): Promise<void> {}

/** Days of this challenge that have a photo. */
export async function listPhotoDays(_challengeId: string): Promise<number[]> {
  return [];
}

export async function deleteChallengePhotos(_challengeId: string): Promise<void> {}

/** Remove every stored photo (used by "すべてのデータを削除"). */
export async function clearAllPhotos(): Promise<void> {}
