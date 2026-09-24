import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { n8n } from "@/lib/n8n";

/**
 * Serves a stored result.
 *
 * Ownership is checked against the session, not against the id in the URL, so
 * guessing an artifact id gets you nothing. The bytes come from MP · Storage
 * API, which is also where the ".." path guard lives.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser();

  const artifact = await prisma.artifact.findFirst({
    where: { id, run: { userId: user.id } },
    include: { run: { include: { installation: true } } },
  });

  if (!artifact) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const reply = await n8n.storage({
    installationId:
      artifact.run.installation.installationId ?? artifact.run.installationId,
    operation: "get",
    path: artifact.path,
  });

  if (!reply.ok || !("content" in reply)) {
    // Seeded rows describe files that were never written to the mock store.
    return NextResponse.json(
      {
        error: "This file is not in storage.",
        detail:
          "Seeded results describe runs that happened before this instance existed.",
        artifact: { name: artifact.name, size: artifact.sizeBytes },
      },
      { status: 404 },
    );
  }

  const download = new URL(request.url).searchParams.has("download");

  return new NextResponse(Buffer.from(reply.content, "base64"), {
    headers: {
      "content-type": reply.mimeType || artifact.mimeType,
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${artifact.name}"`,
      "cache-control": "private, no-store",
    },
  });
}
