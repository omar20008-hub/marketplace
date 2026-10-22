import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { bearerToken, userForAgentKey } from "@/server/agent-keys";
import { fileLinkValid } from "@/server/files/file-links";

/**
 * The original bytes of a saved file. Opened by a signed link (the assistant or a
 * workflow, see file-links.ts), by the person's agent key, or by the person
 * signed in. Served as a download, never rendered.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(request.url);

  let owner: string | null = null;
  if (fileLinkValid(id, url.searchParams.get("exp"), url.searchParams.get("sig"))) {
    owner = (await prisma.userFile.findUnique({ where: { id }, select: { userId: true } }))?.userId ?? null;
  } else {
    owner = (await userForAgentKey(bearerToken(request))) ?? (await currentUser())?.id ?? null;
  }
  if (!owner) return new Response("Not found", { status: 404 });

  const file = await prisma.userFile.findFirst({
    where: { id, userId: owner },
    select: { name: true, mimeType: true, data: true },
  });
  if (!file) return new Response("Not found", { status: 404 });

  return new Response(new Uint8Array(file.data), {
    headers: {
      "content-type": file.mimeType,
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}

export const dynamic = "force-dynamic";
