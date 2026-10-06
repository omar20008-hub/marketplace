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
