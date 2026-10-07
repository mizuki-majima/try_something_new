/**
 * Media stores (share card images). Moderation moves a hidden card's image out of share/ (the only
 * public prefix) and back on restore; uploads carry a short cache so a hidden image leaves
 * CloudFront within minutes.
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CopyObjectCommand, DeleteObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mediaRoutes } from "../src/local";
import { LocalMediaStore, MEDIA_CACHE_CONTROL, MemoryMediaStore, S3MediaStore } from "../src/media";

class FakeS3 {
  readonly sent: unknown[] = [];
  readonly objects = new Set<string>();
  async send(cmd: unknown) {
    this.sent.push(cmd);
    if (cmd instanceof PutObjectCommand) this.objects.add(String(cmd.input.Key));
    if (cmd instanceof DeleteObjectCommand) this.objects.delete(String(cmd.input.Key));
    if (cmd instanceof CopyObjectCommand) {
      const source = String(cmd.input.CopySource).replace(/^bucket\//, "");
      if (!this.objects.has(source)) throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
      this.objects.add(String(cmd.input.Key));
    }
    return {};
  }
}

describe("S3MediaStore", () => {
  it("uploads card images with a 5-minute public cache", async () => {
    const s3 = new FakeS3();
    const store = new S3MediaStore("bucket", "ap-northeast-1", s3 as unknown as S3Client);
    await store.put("share/abc123def456ghi7.png", new Uint8Array([1]), "image/png");
    const put = s3.sent[0] as PutObjectCommand;
    expect(put.input).toMatchObject({ Bucket: "bucket", Key: "share/abc123def456ghi7.png", ContentType: "image/png", CacheControl: "public, max-age=300" });
    expect(MEDIA_CACHE_CONTROL).toBe("public, max-age=300");
  });

  it("moves an object with a server-side copy (headers kept) and a delete; a missing source is false", async () => {
    const s3 = new FakeS3();
    const store = new S3MediaStore("bucket", "ap-northeast-1", s3 as unknown as S3Client);
    await store.put("share/abc123def456ghi7.png", new Uint8Array([1]), "image/png");
    expect(await store.move("share/abc123def456ghi7.png", "hidden/share/abc123def456ghi7.png")).toBe(true);
    const copy = s3.sent[1] as CopyObjectCommand;
    expect(copy.input).toEqual({ Bucket: "bucket", Key: "hidden/share/abc123def456ghi7.png", CopySource: "bucket/share/abc123def456ghi7.png" });
    expect((s3.sent[2] as DeleteObjectCommand).input).toEqual({ Bucket: "bucket", Key: "share/abc123def456ghi7.png" });
    expect([...s3.objects]).toEqual(["hidden/share/abc123def456ghi7.png"]);
    // Already moved: nothing to do, nothing deleted.
    const before = s3.sent.length;
    expect(await store.move("share/abc123def456ghi7.png", "hidden/share/abc123def456ghi7.png")).toBe(false);
    expect(s3.sent.length).toBe(before + 1);
    await expect(store.copy("../etc/passwd", "share/x.png")).rejects.toThrow(/invalid media key/);
  });
});

describe("LocalMediaStore and MemoryMediaStore", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "thirty-media-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("move / copy behave the same in both", async () => {
    for (const store of [new LocalMediaStore(dir), new MemoryMediaStore()]) {
      await store.put("share/abc.png", new Uint8Array([7, 8]), "image/png");
      expect(await store.copy("share/abc.png", "hidden/share/abc.png")).toBe(true);
      expect(await store.move("share/abc.png", "hidden/share/abc.png")).toBe(true);
      expect(await store.move("share/abc.png", "hidden/share/abc.png")).toBe(false);
      expect(await store.copy("share/nothing.png", "hidden/share/nothing.png")).toBe(false);
      expect(await store.move("hidden/share/abc.png", "share/abc.png")).toBe(true);
      await store.delete("hidden/share/abc.png"); // missing: fine
    }
    expect(await readFile(path.join(dir, "share", "abc.png"))).toEqual(Buffer.from([7, 8]));
  });

  it("local /media serves share/ only, never hidden/ (as CloudFront must)", async () => {
    await mkdir(path.join(dir, "hidden", "share"), { recursive: true });
    await writeFile(path.join(dir, "hidden", "share", "gone.png"), Buffer.from([1]));
    await writeFile(path.join(dir, "share", "shown.png"), Buffer.from([2]));
    const app = mediaRoutes(dir);
    expect((await app.request("/media/share/shown.png")).status).toBe(200);
    expect((await app.request("/media/hidden/share/gone.png")).status).toBe(404);
    expect((await app.request("/media/share/../hidden/share/gone.png")).status).toBe(404);
  });
});
