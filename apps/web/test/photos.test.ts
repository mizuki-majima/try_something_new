import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PHOTO_MAX_SIDE,
  PhotoStorageError,
  clearAllPhotos,
  deleteChallengePhotos,
  fitWithin,
  getPhotoUrl,
  listPhotoDays,
  photoErrorMessage,
  photoKey,
  savePhoto,
} from "../src/lib/photos";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fitWithin", () => {
  it("scales the long side down to 1280px and keeps the aspect ratio", () => {
    expect(PHOTO_MAX_SIDE).toBe(1280);
    expect(fitWithin(4000, 3000)).toEqual({ width: 1280, height: 960 });
    expect(fitWithin(3000, 4000)).toEqual({ width: 960, height: 1280 });
    expect(fitWithin(4032, 3024)).toEqual({ width: 1280, height: 960 });
    expect(fitWithin(2000, 2000)).toEqual({ width: 1280, height: 1280 });
  });

  it("never scales up", () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(1280, 720)).toEqual({ width: 1280, height: 720 });
  });

  it("keeps at least one pixel on very thin images", () => {
    expect(fitWithin(10_000, 3)).toEqual({ width: 1280, height: 1 });
  });

  it("rejects empty or invalid sizes", () => {
    expect(fitWithin(0, 100)).toEqual({ width: 0, height: 0 });
    expect(fitWithin(Number.NaN, 100)).toEqual({ width: 0, height: 0 });
    expect(fitWithin(-5, 100)).toEqual({ width: 0, height: 0 });
  });

  it("accepts a custom limit", () => {
    expect(fitWithin(600, 300, 300)).toEqual({ width: 300, height: 150 });
  });
});

describe("photo storage without IndexedDB (private mode)", () => {
  it("throws a typed error the UI can show", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const file = new Blob(["x"], { type: "image/jpeg" });
    const err = await savePhoto("abc123def456", 1, file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PhotoStorageError);
    expect((err as PhotoStorageError).code).toBe("unavailable");
    expect((err as PhotoStorageError).message).toBe("この端末では写真を保存できません");
    expect(photoErrorMessage(err)).toBe("この端末では写真を保存できません");
  });

  it("reads and deletes quietly", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(getPhotoUrl("abc123def456", 1)).resolves.toBeNull();
    await expect(listPhotoDays("abc123def456")).resolves.toEqual([]);
    await expect(deleteChallengePhotos("abc123def456")).resolves.toBeUndefined();
    await expect(clearAllPhotos()).resolves.toBeUndefined();
  });
});

describe("savePhoto input checks", () => {
  it("refuses files that are not images before touching storage", async () => {
    const err = await savePhoto("abc123def456", 2, new Blob(["%PDF"], { type: "application/pdf" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PhotoStorageError);
    expect((err as PhotoStorageError).code).toBe("not_image");
  });

  it("uses one key per challenge and day", () => {
    expect(photoKey("abc123def456", 7)).toBe("abc123def456:7");
  });

  it("maps unknown errors to a generic message", () => {
    expect(photoErrorMessage(new Error("boom"))).toBe("写真を保存できませんでした。もう一度お試しください");
  });
});
