"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { cancelScheduledPost } from "@/server/posts/scheduled-posts";

/**
 * The Posts screen's one write. Ownership is re-checked against the session, not
 * taken from the id in the form: an action is reachable by direct POST whether or
 * not the button that calls it is on screen.
 */
export async function cancelPost(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("postId") ?? "");

  const post = await prisma.scheduledPost.findFirst({
    where: { id, installation: { userId: user.id } },
    select: { installationId: true },
  });
  if (!post) return;

  await cancelScheduledPost(post.installationId, id);
  revalidatePath(`/workspace/${post.installationId}/posts`);
}
