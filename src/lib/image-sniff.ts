/**
 * What an upload really is, from its first bytes. The browser's file type and the
 * file's name are whatever the sender typed, so neither is believed: only a JPEG
 * or a PNG that starts like one is accepted, and the type served back is the one
 * found here.
 */

export type ImageKind = { mime: "image/jpeg" | "image/png"; ext: "jpg" | "png" };

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function sniffImage(bytes: Uint8Array): ImageKind | null {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  // The signature, then an IHDR chunk (length 13) straight after it.
  if (
    bytes.length >= 24 &&
    PNG.every((byte, i) => bytes[i] === byte) &&
    bytes[11] === 0x0d &&
    String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) === "IHDR"
  ) {
    return { mime: "image/png", ext: "png" };
  }
  return null;
}

export type VideoKind = { mime: "video/mp4" | "video/webm"; ext: "mp4" | "webm" };

/**
 * MP4 has an `ftyp` box at offset 4; WebM (Matroska) starts with the EBML header
 * 1A 45 DF A3. As with images, the bytes decide, never the name or the sender.
 */
export function sniffVideo(bytes: Uint8Array): VideoKind | null {
  if (bytes.length >= 12 && String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]) === "ftyp") {
    return { mime: "video/mp4", ext: "mp4" };
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return { mime: "video/webm", ext: "webm" };
  }
  return null;
}

export type MediaKind = ImageKind | VideoKind;

export function sniffMedia(bytes: Uint8Array): MediaKind | null {
  return sniffImage(bytes) ?? sniffVideo(bytes);
}
