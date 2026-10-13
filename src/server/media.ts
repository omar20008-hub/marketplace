import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { sniffImage, sniffMedia, type MediaKind } from "@/lib/image-sniff";

/**
 * Images attached in the chat.
 *
 * Instagram publishes only from a URL its servers can fetch, and a post may be
 * scheduled weeks ahead, so an attachment has to live somewhere that outlasts the
 * conversation and be reachable without a session. It is kept in Postgres and
 * served from an unguessable link (256 random bits; only the hash is stored). The
 * link works until `expiresAt`, set beyond the furthest a post can be scheduled
 * (75 days), and the tick deletes what has expired.
 *
 * Not a "use server" module: everything exported would be reachable by direct POST.
 */

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // Instagram's own limit
/** Generated video (a clip of a few seconds) — larger than an image, far from the size of a film. */
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_ACTIVE_IMAGES = 50;
const MAX_ACTIVE_BYTES = 200 * 1024 * 1024;
const KEEP_MS = 90 * 24 * 60 * 60 * 1000;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export type SaveResult =
  | { ok: true; token: string; kind: MediaKind; name: string; sizeBytes: number }
  | { ok: false; error: string };

/** A picture a person attaches in the chat: JPEG or PNG only. */
export async function saveMedia(
  userId: string,
  fileName: string,
  bytes: Uint8Array,
  now = new Date(),
): Promise<SaveResult> {
  return store(userId, fileName, bytes, now, "image");
}

/**
 * Something the platform generated for a reply (an image or a short video). Stored
 * the same way, and reached through the same unguessable link, so the chat can show it.
 */
export async function saveGeneratedMedia(
  userId: string,
  fileName: string,
  bytes: Uint8Array,
  now = new Date(),
): Promise<SaveResult> {
  return store(userId, fileName, bytes, now, "any");
}

async function store(
  userId: string,
  fileName: string,
  bytes: Uint8Array,
  now: Date,
  accept: "image" | "any",
): Promise<SaveResult> {
  if (bytes.length === 0) return { ok: false, error: "The file is empty." };
  if (bytes.length > MAX_VIDEO_BYTES) return { ok: false, error: "The file is larger than 50 MB." };
  const kind: MediaKind | null = accept === "image" ? sniffImage(bytes) : sniffMedia(bytes);
  if (!kind) {
    return {
      ok: false,
      error: accept === "image" ? "Only JPEG and PNG images can be attached." : "Only JPEG, PNG, MP4 and WebM files can be stored.",
    };
  }
  if (kind.mime.startsWith("video/") ? bytes.length > MAX_VIDEO_BYTES : bytes.length > MAX_IMAGE_BYTES) {
    return { ok: false, error: kind.mime.startsWith("video/") ? "The video is larger than 50 MB." : "The image is larger than 8 MB." };
  }

  const active = await prisma.mediaUpload.aggregate({
    where: { userId, expiresAt: { gt: now } },
    _count: true,
    _sum: { sizeBytes: true },
  });
  if (active._count >= MAX_ACTIVE_IMAGES || (active._sum.sizeBytes ?? 0) + bytes.length > MAX_ACTIVE_BYTES) {
    return { ok: false, error: "You have reached the limit for stored images. Older ones expire after 90 days." };
  }

  // A name is only a label. Strip anything path-like and bound it.
  const name = (fileName.split(/[\\/]/).pop() ?? "image").replace(/[^\p{L}\p{N} ._()-]/gu, "_").slice(0, 80) || "image";
  const token = randomBytes(32).toString("base64url");
  await prisma.mediaUpload.create({
    data: {
      userId,
      tokenHash: hash(token),
      name,
      mimeType: kind.mime,
      sizeBytes: bytes.length,
      data: Buffer.from(bytes),
      expiresAt: new Date(now.getTime() + KEEP_MS),
    },
  });
  return { ok: true, token, kind, name, sizeBytes: bytes.length };
}

/** The path a stored image is served from. The extension is for the fetching network's benefit. */
export function mediaPath(token: string, kind: MediaKind) {
  return `/api/media/${token}.${kind.ext}`;
}

const FILE = /^([A-Za-z0-9_-]{43})\.(jpg|png|mp4|webm)$/;

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

/** The image behind a link, or null if it is unknown, expired, or the extension does not match. */
export async function findMedia(file: string, now = new Date()) {
  const match = FILE.exec(file);
  if (!match) return null;
  const media = await prisma.mediaUpload.findUnique({ where: { tokenHash: hash(match[1]) } });
  if (!media || media.expiresAt <= now) return null;
  return EXT_BY_MIME[media.mimeType] === match[2] ? media : null;
}

export type Attachment = { url: string; name: string; mime: string };

/**
 * Turns the links a form submitted into attachments this user really owns. A link
 * is accepted only if its token is one of this user's live uploads — so a form
 * cannot smuggle in someone else's image, or an arbitrary address, to be passed
 * on to the assistant as "the image".
 */
export async function resolveAttachments(userId: string, submitted: string[], now = new Date()): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const raw of submitted.slice(0, MAX_IMAGES_PER_MESSAGE)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    const file = /^\/api\/media\/([^/]+)$/.exec(url.pathname)?.[1];
    if (!file || (url.protocol !== "https:" && url.protocol !== "http:")) continue;
    const media = await findMedia(file, now);
    if (!media || media.userId !== userId || !media.mimeType.startsWith("image/")) continue;
    out.push({ url: `${url.origin}${url.pathname}`, name: media.name, mime: media.mimeType });
  }
  return out;
}

/** What the person sees in their message, and what the assistant is told. */
export function describeAttachments(attachments: Attachment[]) {
  if (attachments.length === 0) return { shown: "", forAssistant: "" };
  return {
    shown: attachments.map((a) => `Attached image: ${a.url}`).join("\n"),
    forAssistant:
      "[The user attached " +
      (attachments.length === 1 ? "an image" : `${attachments.length} images`) +
      ". Use these exact public URLs as the post's mediaUrl: " +
      attachments.map((a) => `${a.url} (${a.mime === "image/png" ? "PNG" : "JPEG"})`).join(", ") +
      "]",
  };
}

export async function purgeExpiredMedia(now = new Date()): Promise<number> {
  const { count } = await prisma.mediaUpload.deleteMany({ where: { expiresAt: { lte: now } } });
  return count;
}
