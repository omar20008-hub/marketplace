import { NextResponse } from "next/server";
import { installationForKey } from "@/server/knowledge/keys";
import { cancelScheduledPost } from "@/server/posts/scheduled-posts";

/** Cancels a post that has not started publishing. 404 for anyone else's, like every id route here. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const installation = await installationForKey(request.headers.get("authorization"));
  if (!installation) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const cancelled = await cancelScheduledPost(installation.id, id);
  if (!cancelled) {
    return NextResponse.json({ error: "Not found, or already publishing" }, { status: 404 });
  }
  return NextResponse.json({ id, status: "CANCELLED" });
}

export const dynamic = "force-dynamic";
