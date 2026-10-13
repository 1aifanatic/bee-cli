import { describe, expect, it } from "bun:test";
import { contentTypeForFilename, imageSize, loadAttachment } from "@/resources/threads/attachments";

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const data = new DataView(bytes.buffer);
  data.setUint32(16, width);
  data.setUint32(20, height);
  return bytes;
}

// SOI, APP1 Exif (big-endian TIFF, IFD0 with one Orientation entry), SOF0.
function jpegBytes(width: number, height: number, orientation: number | null): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  if (orientation !== null) {
    const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];
    const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const length = payload.length + 2;
    parts.push(0xff, 0xe1, length >> 8, length & 0xff, ...payload);
  }
  parts.push(0xff, 0xc0, 0, 17, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, ...new Array(9).fill(0));
  return new Uint8Array(parts);
}

describe("thread attachments", () => {
  it("detects content types from the extension", () => {
    expect(contentTypeForFilename("IMG_1.JPG")).toBe("image/jpeg");
    expect(contentTypeForFilename("a.png")).toBe("image/png");
    expect(contentTypeForFilename("notes.pdf")).toBe("application/pdf");
    expect(contentTypeForFilename("readme.md")).toBe("text/markdown");
    expect(contentTypeForFilename("blob")).toBe("application/octet-stream");
  });

  it("reads PNG and GIF sizes", () => {
    expect(imageSize(pngBytes(640, 480))).toEqual({ width: 640, height: 480 });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x03, 0x58, 0x02]);
    expect(imageSize(gif)).toEqual({ width: 800, height: 600 });
  });

  it("reads JPEG sizes and swaps them for a rotated EXIF orientation", () => {
    expect(imageSize(jpegBytes(4032, 3024, null))).toEqual({ width: 4032, height: 3024 });
    expect(imageSize(jpegBytes(4032, 3024, 1))).toEqual({ width: 4032, height: 3024 });
    expect(imageSize(jpegBytes(4032, 3024, 6))).toEqual({ width: 3024, height: 4032 });
  });

  it("reads WebP VP8X sizes", () => {
    const bytes = new Uint8Array(30);
    bytes.set([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8X")]);
    // canvas width-1 = 1023, height-1 = 767 (24-bit little endian at 24 and 27)
    bytes.set([0xff, 0x03, 0x00, 0xff, 0x02, 0x00], 24);
    expect(imageSize(bytes)).toEqual({ width: 1024, height: 768 });
  });

  it("returns null for unknown or truncated data", () => {
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(imageSize(jpegBytes(10, 10, null).subarray(0, 8))).toBeNull();
  });

  it("decodes inline base64 (also as a data: URL) and sizes images", () => {
    const base64 = Buffer.from(pngBytes(2, 3)).toString("base64");
    const loaded = loadAttachment({ kind: "inline", data: `data:image/png;base64,${base64}`, filename: "x.png", contentType: undefined });
    expect(loaded.contentType).toBe("image/png");
    expect(loaded).toMatchObject({ width: 2, height: 3, filename: "x.png" });
  });

  it("rejects invalid inline base64", () => {
    expect(() => loadAttachment({ kind: "inline", data: "not base64!", filename: "x.png", contentType: undefined }))
      .toThrow("Inline file x.png is not valid base64.");
  });

  it("rejects a missing path", () => {
    expect(() => loadAttachment({ kind: "path", path: "/nonexistent/x.png", photo: true }))
      .toThrow("Cannot read /nonexistent/x.png: no such file");
  });
});
