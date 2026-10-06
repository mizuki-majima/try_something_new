/**
 * Per-day photos, stored ONLY on this device (IndexedDB), never uploaded (SPEC FR-5).
 *
 * savePhoto() decodes the picked file, scales it to at most PHOTO_MAX_SIDE on the long side and
 * re-encodes it as JPEG through a canvas. Re-encoding keeps only pixels, so EXIF (GPS location,
 * camera, time) never reaches storage. Records live in the "thirty-days-photos" database under the
 * key "<challengeId>:<day>".
 *
 * IndexedDB can be missing or refuse to open (some private windows, blocked site data): saving
 * then throws a PhotoStorageError("unavailable") — the UI shows 「この端末では写真を保存できません」.
 * Reads and deletes quietly do nothing in that case.
 */

export const PHOTO_DB_NAME = "thirty-days-photos";
const STORE = "photos";
const DB_VERSION = 1;

/** Long side of a stored photo, in pixels. */
export const PHOTO_MAX_SIDE = 1280;
export const PHOTO_JPEG_QUALITY = 0.82;
/** Refuse absurdly large inputs before decoding them (phones produce ~3–15MB). */
export const PHOTO_MAX_INPUT_BYTES = 60 * 1024 * 1024;

export type PhotoErrorCode = "unavailable" | "not_image" | "too_large" | "decode" | "quota" | "failed";

const MESSAGES: Record<PhotoErrorCode, string> = {
  unavailable: "この端末では写真を保存できません",
  not_image: "画像のファイルを選んでください",
  too_large: "画像が大きすぎます。別の写真を選んでください",
  decode: "この画像は読み込めませんでした。別の写真を選んでください",
  quota: "端末の空き容量が足りないため、写真を保存できません",
  failed: "写真を保存できませんでした。もう一度お試しください",
};

export class PhotoStorageError extends Error {
  readonly code: PhotoErrorCode;
  constructor(code: PhotoErrorCode, message: string = MESSAGES[code]) {
    super(message);
    this.name = "PhotoStorageError";
    this.code = code;
  }
}

export function isPhotoStorageError(err: unknown): err is PhotoStorageError {
  return err instanceof PhotoStorageError;
}

/** A user-facing message for anything thrown by this module. */
export function photoErrorMessage(err: unknown): string {
  return isPhotoStorageError(err) ? err.message : MESSAGES.failed;
}

export function photoKey(challengeId: string, day: number): string {
  return `${challengeId}:${day}`;
}

/** Scale (width, height) down so the long side is at most maxSide. Never scales up. */
export function fitWithin(width: number, height: number, maxSide: number = PHOTO_MAX_SIDE): { width: number; height: number } {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) return { width: 0, height: 0 };
  const long = Math.max(width, height);
  if (long <= maxSide) return { width: Math.round(width), height: Math.round(height) };
  const scale = maxSide / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// ---------- IndexedDB ----------

type PhotoRecord = { blob: Blob; width: number; height: number; savedAt: number };

let dbPromise: Promise<IDBDatabase> | null = null;

function idb(): IDBFactory | null {
  try {
    return typeof indexedDB === "undefined" || !indexedDB ? null : indexedDB;
  } catch {
    return null; // some browsers throw on access when site data is blocked
  }
}

function openDb(): Promise<IDBDatabase> {
  const factory = idb();
  if (!factory) return Promise.reject(new PhotoStorageError("unavailable"));
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(PHOTO_DB_NAME, DB_VERSION);
    } catch {
      reject(new PhotoStorageError("unavailable"));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(new PhotoStorageError("unavailable"));
    req.onblocked = () => reject(new PhotoStorageError("unavailable"));
  }).catch((err: unknown) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

function toPhotoError(err: unknown): PhotoStorageError {
  if (err instanceof PhotoStorageError) return err;
  const name = (err as { name?: unknown } | null)?.name;
  if (name === "QuotaExceededError") return new PhotoStorageError("quota");
  if (name === "InvalidStateError" || name === "SecurityError") return new PhotoStorageError("unavailable");
  return new PhotoStorageError("failed");
}

/** Run one request in a transaction and resolve with its result once the transaction commits. */
async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  return new Promise<T | undefined>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, mode);
    } catch (err) {
      reject(toPhotoError(err));
      return;
    }
    let result: T | undefined;
    try {
      const req = fn(tx.objectStore(STORE));
      if (req) req.onsuccess = () => (result = req.result);
    } catch (err) {
      reject(toPhotoError(err));
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(toPhotoError(tx.error));
    tx.onabort = () => reject(toPhotoError(tx.error));
  });
}

/** Keys "<challengeId>:<day>" of one challenge ("￿" sorts after every digit). */
function challengeRange(challengeId: string): IDBKeyRange {
  return IDBKeyRange.bound(`${challengeId}:`, `${challengeId}:￿`);
}

/** True when photos can be stored on this device (tries to open the database). */
export async function canStorePhotos(): Promise<boolean> {
  try {
    await openDb();
    return true;
  } catch {
    return false;
  }
}

// ---------- decoding / re-encoding ----------

type Decoded = { source: CanvasImageSource; width: number; height: number; release: () => void };

async function decodeImage(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      // "from-image" applies the EXIF orientation before the metadata is thrown away.
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // Older Safari: no options / no HEIC → try an <img>.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new PhotoStorageError("decode"));
      img.src = url;
    });
    if (!img.naturalWidth || !img.naturalHeight) throw new PhotoStorageError("decode");
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err instanceof PhotoStorageError ? err : new PhotoStorageError("decode");
  }
}

/** Downscale + JPEG re-encode. The output carries no EXIF or location. */
export async function reencodePhoto(file: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  const decoded = await decodeImage(file);
  try {
    const { width, height } = fitWithin(decoded.width, decoded.height);
    if (!width || !height) throw new PhotoStorageError("decode");
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new PhotoStorageError("failed");
    // JPEG has no alpha: transparent areas would turn black without a background.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(decoded.source, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", PHOTO_JPEG_QUALITY));
    if (!blob) throw new PhotoStorageError("failed");
    return { blob, width, height };
  } finally {
    decoded.release();
  }
}

// ---------- public API (signatures used by other pages; keep stable) ----------

/** Resize/re-encode (drops EXIF/location) and store the photo for one day of a challenge. */
export async function savePhoto(challengeId: string, day: number, file: Blob): Promise<void> {
  if (file.type && !file.type.startsWith("image/")) throw new PhotoStorageError("not_image");
  if (file.size > PHOTO_MAX_INPUT_BYTES) throw new PhotoStorageError("too_large");
  await openDb(); // fail fast (private mode) before the expensive decode
  const { blob, width, height } = await reencodePhoto(file);
  const record: PhotoRecord = { blob, width, height, savedAt: Date.now() };
  await withStore("readwrite", (store) => store.put(record, photoKey(challengeId, day)));
}

/** Object URL for the stored photo, or null. Caller revokes it. */
export async function getPhotoUrl(challengeId: string, day: number): Promise<string | null> {
  try {
    const rec = await withStore<PhotoRecord | undefined>("readonly", (store) => store.get(photoKey(challengeId, day)));
    return rec?.blob instanceof Blob ? URL.createObjectURL(rec.blob) : null;
  } catch {
    return null;
  }
}

export async function deletePhoto(challengeId: string, day: number): Promise<void> {
  if (!idb()) return;
  await withStore("readwrite", (store) => store.delete(photoKey(challengeId, day)));
}

/** Days of this challenge that have a photo. */
export async function listPhotoDays(challengeId: string): Promise<number[]> {
  try {
    const keys = await withStore<IDBValidKey[]>("readonly", (store) => store.getAllKeys(challengeRange(challengeId)));
    return (keys ?? [])
      .map((k) => Number(String(k).slice(challengeId.length + 1)))
      .filter((n) => Number.isInteger(n) && n >= 1)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

export async function deleteChallengePhotos(challengeId: string): Promise<void> {
  if (!idb()) return;
  try {
    await withStore("readwrite", (store) => store.delete(challengeRange(challengeId)));
  } catch (err) {
    if (!(isPhotoStorageError(err) && err.code === "unavailable")) throw err;
  }
}

/** Remove every stored photo (used by "すべてのデータを削除"). */
export async function clearAllPhotos(): Promise<void> {
  if (!idb()) return;
  try {
    await withStore("readwrite", (store) => store.clear());
  } catch (err) {
    if (!(isPhotoStorageError(err) && err.code === "unavailable")) throw err;
  }
}
