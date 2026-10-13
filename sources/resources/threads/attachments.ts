// Local attachment loading for thread messages: reads a file (or inline base64),
// detects its content type from the extension, and reads image dimensions from
// the header bytes (PNG, JPEG, GIF, WebP) without any image dependency.
import { readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

// Server limits (bee-server attachmentUpload.ts and devThreads.ts).
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_THREAD_FILES = 20;

export type AttachmentSource =
  | { kind: "path"; path: string; photo: boolean }
  | { kind: "inline"; data: string; filename: string; contentType: string | undefined };

export type LoadedAttachment = {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  width: number | null;
  height: number | null;
};

const CONTENT_TYPES: { readonly [extension: string]: string } = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  rtf: "application/rtf",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

export function contentTypeForFilename(filename: string): string {
  const extension = extname(filename).slice(1).toLowerCase();
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

export function loadAttachment(source: AttachmentSource): LoadedAttachment {
  if (source.kind === "path") {
    return loadPath(source.path, source.photo);
  }
  const bytes = decodeBase64(source.data, source.filename);
  checkSize(bytes.length, source.filename);
  const contentType = source.contentType ?? contentTypeForFilename(source.filename);
  return { filename: source.filename, contentType, bytes, ...dimensionsFor(contentType, bytes) };
}

function loadPath(path: string, photo: boolean): LoadedAttachment {
  const absolute = resolve(path);
  let size: number;
  try {
    const stat = statSync(absolute);
    if (!stat.isFile()) {
      throw new Error("not a regular file");
    }
    size = stat.size;
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${readError(error)}`);
  }
  // Check the size before reading so a huge file is not loaded into memory.
  checkSize(size, path);
  const filename = basename(absolute);
  const contentType = contentTypeForFilename(filename);
  if (photo && !contentType.startsWith("image/")) {
    throw new Error(`--photo expects an image (jpg, png, gif, webp, heic): ${path}. Use --file for other files.`);
  }
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(absolute);
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${readError(error)}`);
  }
  if (bytes.length === 0) {
    throw new Error(`File is empty: ${path}`);
  }
  return { filename, contentType, bytes, ...dimensionsFor(contentType, bytes) };
}

function checkSize(size: number, label: string): void {
  if (size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`File too large (max 25 MB): ${label}`);
  }
}

function readError(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    return "no such file";
  }
  return error instanceof Error ? error.message : "unexpected error";
}

// Accepts plain base64 or a data: URL. Throws on anything that does not decode.
function decodeBase64(data: string, filename: string): Uint8Array {
  const payload = data.replace(/^data:[^,]*;base64,/, "").replace(/\s+/g, "");
  if (payload.length === 0 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(payload)) {
    throw new Error(`Inline file ${filename} is not valid base64.`);
  }
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length === 0) {
    throw new Error(`Inline file ${filename} is empty.`);
  }
  return bytes;
}

function dimensionsFor(contentType: string, bytes: Uint8Array): { width: number | null; height: number | null } {
  const size = contentType.startsWith("image/") ? imageSize(bytes) : null;
  return { width: size?.width ?? null, height: size?.height ?? null };
}

// ---- image header parsing ---------------------------------------------------

export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  try {
    const size = pngSize(bytes) ?? gifSize(bytes) ?? webpSize(bytes) ?? jpegSize(bytes);
    return size && size.width > 0 && size.height > 0 ? size : null;
  } catch {
    // A truncated or odd header just means "unknown size".
    return null;
  }
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || ascii(bytes, 1, 3) !== "PNG" || ascii(bytes, 12, 4) !== "IHDR") {
    return null;
  }
  const data = view(bytes);
  return { width: data.getUint32(16), height: data.getUint32(20) };
}

function gifSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 10 || !/^GIF8[79]a$/.test(ascii(bytes, 0, 6))) {
    return null;
  }
  const data = view(bytes);
  return { width: data.getUint16(6, true), height: data.getUint16(8, true) };
}

function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") {
    return null;
  }
  const data = view(bytes);
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8 ") {
    return { width: data.getUint16(26, true) & 0x3fff, height: data.getUint16(28, true) & 0x3fff };
  }
  if (chunk === "VP8L") {
    const b0 = bytes[21]!;
    const b1 = bytes[22]!;
    const b2 = bytes[23]!;
    const b3 = bytes[24]!;
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  if (chunk === "VP8X") {
    const uint24 = (offset: number) => bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
    return { width: 1 + uint24(24), height: 1 + uint24(27) };
  }
  return null;
}

// Walks JPEG segments to the first SOFn frame header. An EXIF orientation of
// 5-8 (rotated 90/270 degrees) swaps the reported width and height so they
// match how the photo is displayed.
function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }
  const data = view(bytes);
  let orientation = 1;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      return null;
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // standalone marker, no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      return null; // end of image / start of scan before any frame header
    }
    const length = data.getUint16(offset + 2);
    if (isStartOfFrame(marker)) {
      const height = data.getUint16(offset + 5);
      const width = data.getUint16(offset + 7);
      return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height };
    }
    if (marker === 0xe1) {
      orientation = exifOrientation(bytes.subarray(offset + 4, offset + 2 + length)) ?? orientation;
    }
    offset += 2 + length;
  }
  return null;
}

function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

// Reads the IFD0 Orientation tag of an APP1 segment payload. Anything malformed
// yields null, so a broken EXIF block never hides the frame size.
function exifOrientation(segment: Uint8Array): number | null {
  try {
    if (segment.length < 14 || ascii(segment, 0, 6) !== "Exif\0\0") {
      return null;
    }
    const tiff = 6;
    const order = ascii(segment, tiff, 2);
    if (order !== "II" && order !== "MM") {
      return null;
    }
    const little = order === "II";
    const data = view(segment);
    const ifd = tiff + data.getUint32(tiff + 4, little);
    const entries = data.getUint16(ifd, little);
    for (let index = 0; index < entries; index += 1) {
      const entry = ifd + 2 + index * 12;
      if (data.getUint16(entry, little) === 0x0112) {
        return data.getUint16(entry + 8, little);
      }
    }
    return null;
  } catch {
    return null;
  }
}
