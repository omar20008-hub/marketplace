import { findMedia } from "@/server/media";

/**
 * Serves an attached image to whoever holds the link — Instagram's and Facebook's
 * servers have no session, so the unguessable token is the credential. 404 for an
 * unknown, expired or mistyped link alike.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const media = await findMedia(file);
  if (!media) return new Response("Not found", { status: 404 });

  return new Response(new Uint8Array(media.data), {
    headers: {
      "content-type": media.mimeType,
      "content-length": String(media.sizeBytes),
      // Served as the image it was sniffed to be and never as anything else.
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
      "cache-control": "public, max-age=3600",
    },
  });
}

export const dynamic = "force-dynamic";
