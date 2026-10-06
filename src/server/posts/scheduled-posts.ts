import { prisma } from "@/lib/db";
import { executeRun } from "@/server/run-engine";
import { statusLabel } from "@/server/scheduler";

/**
 * The queue behind the Post Scheduler template.
 *
 * The installed workflow cannot hold a post until its time — an on-demand run
 * returns at once — so it hands the post here (/api/posts, authenticated by the
 * installation's own key) and this module keeps it. When the time comes the tick
 * gives the post back to that same installation through executeRun(), which is
 * the path the Run button takes: the readiness check, the plan limit and the
 * argument validator all apply, and the workflow does the actual publishing with
 * the user's own Facebook connection. Nothing here ever sees a token.
 *
 * Not a "use server" module, for the same reason as run-engine.ts: everything
 * exported would be reachable by direct POST.
 */

export const NETWORKS = ["facebook", "instagram"] as const;
export type Network = (typeof NETWORKS)[number];

const MAX_CAPTION = 2200; // Instagram's limit, the stricter of the two
const MIN_LEAD_MS = 60_000;
const MAX_LEAD_MS = 75 * 24 * 60 * 60 * 1000; // Facebook's own ceiling for scheduling
/** A post claimed longer ago than this was abandoned by a tick that died. */
const STALE_CLAIM_MS = 15 * 60_000;

export type PostInput = {
  caption: string;
  networks: Network[];
  mediaUrl: string | null;
  pageId: string | null;
  scheduledAt: Date;
};

type Parsed = { ok: true; value: PostInput } | { ok: false; error: string };

function asList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\s]+/) : [];
  return [...new Set(raw.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
}

/** Validates what the workflow sent. Every refusal is a sentence the assistant can relay. */
export function parsePostInput(body: unknown, now = new Date()): Parsed {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;

  const caption = typeof input.caption === "string" ? input.caption.trim() : "";
  if (!caption) return { ok: false, error: "caption is required" };
  if (caption.length > MAX_CAPTION) {
    return { ok: false, error: `caption is at most ${MAX_CAPTION} characters` };
  }

  const names = asList(input.networks);
  const unknown = names.filter((name) => !(NETWORKS as readonly string[]).includes(name));
  if (names.length === 0) return { ok: false, error: "networks is required: facebook, instagram or both" };
  if (unknown.length > 0) return { ok: false, error: `unsupported network: ${unknown.join(", ")}` };
  const networks = names as Network[];

  let mediaUrl: string | null = null;
  if (typeof input.mediaUrl === "string" && input.mediaUrl.trim()) {
    try {
      const url = new URL(input.mediaUrl.trim());
      if (url.protocol !== "https:") throw new Error("not https");
      mediaUrl = url.toString();
    } catch {
      return { ok: false, error: "mediaUrl must be a public https link to the image" };
    }
  }
  if (networks.includes("instagram") && !mediaUrl) {
    return { ok: false, error: "Instagram posts need an image: mediaUrl is required" };
  }

  const pageId = typeof input.pageId === "string" && input.pageId.trim() ? input.pageId.trim() : null;
  if (pageId && !/^\d{5,32}$/.test(pageId)) {
    return { ok: false, error: "pageId must be a numeric Facebook Page id" };
  }

  const scheduledAt = new Date(typeof input.scheduledAt === "string" ? input.scheduledAt : NaN);
  if (Number.isNaN(scheduledAt.getTime())) {
    return { ok: false, error: "scheduledAt must be an ISO 8601 date and time, e.g. 2026-10-20T09:30:00Z" };
  }
  const lead = scheduledAt.getTime() - now.getTime();
  if (lead < MIN_LEAD_MS) return { ok: false, error: "scheduledAt must be at least a minute in the future" };
  if (lead > MAX_LEAD_MS) return { ok: false, error: "scheduledAt is at most 75 days ahead" };

  return { ok: true, value: { caption, networks, mediaUrl, pageId, scheduledAt } };
}

export function createScheduledPost(installationId: string, input: PostInput) {
  return prisma.scheduledPost.create({ data: { installationId, ...input } });
}

export function listScheduledPosts(installationId: string) {
  return prisma.scheduledPost.findMany({
    where: { installationId },
    orderBy: { scheduledAt: "asc" },
    take: 100,
  });
}

/** Cancels a post that has not started publishing. False if it is not this installation's, or too late. */
export async function cancelScheduledPost(installationId: string, id: string): Promise<boolean> {
  const result = await prisma.scheduledPost.updateMany({
    where: { id, installationId, status: "SCHEDULED" },
    data: { status: "CANCELLED" },
  });
  return result.count > 0;
}

export type PostOutcome = { postId: string; status: "PUBLISHED" | "FAILED" | "claimed-elsewhere" };

/**
 * Publishes every post that is due. A post is tried once: if the workflow fails
 * after Facebook accepted the call, trying again would post twice, so a failure
 * is recorded on the post for the owner to see and decide.
 */
export async function runDuePosts({
  now = new Date(),
  limit = 25,
}: { now?: Date; limit?: number } = {}): Promise<{ checked: number; outcomes: PostOutcome[] }> {
  // A tick that died after claiming leaves PUBLISHING behind. Whether the post
  // went out is unknowable from here, so say that instead of re-sending it.
  await prisma.scheduledPost.updateMany({
    where: { status: "PUBLISHING", claimedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } },
    data: { status: "FAILED", result: "Interrupted while publishing — check the page before posting again." },
  });

  const due = await prisma.scheduledPost.findMany({
    where: { status: "SCHEDULED", scheduledAt: { lte: now } },
    orderBy: { scheduledAt: "asc" },
    take: limit,
  });

  const outcomes: PostOutcome[] = [];
  for (const post of due) {
    const claim = await prisma.scheduledPost.updateMany({
      where: { id: post.id, status: "SCHEDULED" },
      data: { status: "PUBLISHING", claimedAt: now, attempts: { increment: 1 } },
    });
    if (claim.count === 0) {
      outcomes.push({ postId: post.id, status: "claimed-elsewhere" });
      continue;
    }

    let status: "PUBLISHED" | "FAILED" = "FAILED";
    let result: string;
    try {
      // The owner comes from the installation row, never from the caller.
      const installation = await prisma.installation.findUnique({
        where: { id: post.installationId },
        include: { user: { include: { plan: true } } },
      });
      if (!installation) throw new Error("Installation no longer exists");

      const run = await executeRun({
        user: installation.user,
        installationId: installation.id,
        args: {
          postId: post.id,
          caption: post.caption,
          networks: post.networks.join(","),
          scheduledAt: post.scheduledAt.toISOString(),
          ...(post.mediaUrl ? { mediaUrl: post.mediaUrl } : {}),
          ...(post.pageId ? { pageId: post.pageId } : {}),
        },
      });
      if (run?.result === "SUCCESS") {
        status = "PUBLISHED";
        result = run.message ?? "Published";
      } else {
        result = [statusLabel(run), run?.message].filter(Boolean).join(" · ");
      }
    } catch (error) {
      result = error instanceof Error ? `Failed · ${error.message}` : "Failed";
    }

    await prisma.scheduledPost.update({
      where: { id: post.id },
      data: {
        status,
        result: result.slice(0, 1000),
        publishedAt: status === "PUBLISHED" ? new Date() : null,
        claimedAt: null,
      },
    });
    outcomes.push({ postId: post.id, status });
  }

  return { checked: due.length, outcomes };
}
