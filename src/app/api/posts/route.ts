import { NextResponse } from "next/server";
import { hit } from "@/lib/rate-limit";
import { installationForKey } from "@/server/knowledge/keys";
import {
  createScheduledPost,
  listScheduledPosts,
  parsePostInput,
} from "@/server/posts/scheduled-posts";

/**
 * The Post Scheduler's queue, called by an installed workflow — not by a
 * browser. Authenticated by the installation's own key (the same kb_… key the
 * knowledge search uses), and every row it touches belongs to that installation.
 */

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });

export async function POST(request: Request) {
  const installation = await installationForKey(request.headers.get("authorization"));
  if (!installation) return unauthorized();

  const limiter = hit(`posts:${installation.id}`, { limit: 60, windowMs: 60_000 });
  if (!limiter.ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "retry-after": String(limiter.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const parsed = parsePostInput(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const post = await createScheduledPost(installation.id, parsed.value);
  return NextResponse.json(
    { id: post.id, status: post.status, scheduledAt: post.scheduledAt.toISOString() },
    { status: 201 },
  );
}

export async function GET(request: Request) {
  const installation = await installationForKey(request.headers.get("authorization"));
  if (!installation) return unauthorized();

  const posts = await listScheduledPosts(installation.id);
  return NextResponse.json({
    posts: posts.map((post) => ({
      id: post.id,
      status: post.status,
      scheduledAt: post.scheduledAt.toISOString(),
      networks: post.networks,
      caption: post.caption,
      mediaUrl: post.mediaUrl,
      result: post.result,
    })),
  });
}

export const dynamic = "force-dynamic";
