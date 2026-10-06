import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  FootNote,
  PageTitle,
  SectionLabel,
  type BadgeTone,
} from "@/components/ds";
import { postsActivity } from "@/lib/posts";
import { cancelPost } from "@/server/post-actions";
import { AutoRefresh } from "../files/parts";
import type { PostStatus } from "@/generated/prisma";

export const metadata = { title: "Posts · Builder" };

const STATUS: Record<PostStatus, { label: string; tone: BadgeTone }> = {
  SCHEDULED: { label: "Scheduled", tone: "plan" },
  PUBLISHING: { label: "Publishing", tone: "partial" },
  PUBLISHED: { label: "Published", tone: "ready" },
  FAILED: { label: "Failed", tone: "blocked" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

const NETWORK: Record<string, string> = { facebook: "Facebook", instagram: "Instagram" };

/** The platform keeps time in UTC everywhere, and says so. */
const when = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});
const utc = (date: Date) => `${when.format(date)} UTC`;

export default async function PostsPage({
  params,
}: {
  params: Promise<{ installationId: string }>;
}) {
  const { installationId } = await params;
  const user = await requireUser();

  const installation = await prisma.installation.findFirst({
    where: { id: installationId, userId: user.id, status: { not: "UNINSTALLED" } },
    include: {
      product: { select: { title: true, usesPosts: true } },
      posts: { orderBy: { scheduledAt: "asc" }, take: 200 },
    },
  });
  if (!installation || !installation.product.usesPosts) notFound();

  const upcoming = installation.posts.filter(
    (post) => post.status === "SCHEDULED" || post.status === "PUBLISHING",
  );
  const history = installation.posts
    .filter((post) => post.status !== "SCHEDULED" && post.status !== "PUBLISHING")
    .reverse();
  const { stalled, busy } = postsActivity(installation.posts);

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-5 py-8">
      <AutoRefresh active={busy} />
      <div>
        <Link
          href="/workspace"
          className="mb-3 inline-flex items-center gap-1 text-[13px] text-ink-2 hover:text-ink"
        >
          <ChevronLeft size={14} /> My workspace
        </Link>
        <PageTitle
          title={`Posts · ${installation.product.title}`}
          meta="Posts waiting for their time, and what happened to the rest. Ask in the chat to schedule more."
        />
      </div>

      {stalled ? (
        <p
          role="alert"
          className="rounded-card bg-warn-tint px-4 py-3 text-[13px] leading-relaxed text-warn-ink"
        >
          A post is past its time and has not gone out. The platform&rsquo;s scheduled clock may
          be stopped. Ask the platform administrator to check it.
        </p>
      ) : null}

      <section className="flex flex-col gap-3">
        <SectionLabel>Upcoming</SectionLabel>
        {upcoming.length === 0 ? (
          <EmptyState
            title="Nothing scheduled"
            body="Tell the assistant what to post, where, and when, and it will appear here."
          />
        ) : (
          upcoming.map((post) => <PostRow key={post.id} post={post} cancellable />)
        )}
      </section>

      {history.length > 0 ? (
        <section className="flex flex-col gap-3">
          <SectionLabel>History</SectionLabel>
          {history.map((post) => (
            <PostRow key={post.id} post={post} />
          ))}
        </section>
      ) : null}

      <FootNote>
        All times are UTC. A post is tried once: if it fails, it is not retried, so it can never be
        published twice.
      </FootNote>
    </div>
  );
}

function PostRow({
  post,
  cancellable = false,
}: {
  post: {
    id: string;
    caption: string;
    mediaUrl: string | null;
    networks: string[];
    scheduledAt: Date;
    status: PostStatus;
    result: string | null;
  };
  cancellable?: boolean;
}) {
  const status = STATUS[post.status];
  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className="text-[13px] text-ink-2">{utc(post.scheduledAt)}</span>
        <span className="text-xs text-ink-3">
          {post.networks.map((network) => NETWORK[network] ?? network).join(" · ")}
        </span>
        {cancellable && post.status === "SCHEDULED" ? (
          <form action={cancelPost} className="ml-auto">
            <input type="hidden" name="postId" value={post.id} />
            <Button type="submit" size="sm" tone="secondary">
              Cancel
            </Button>
          </form>
        ) : null}
      </div>
      <p className="line-clamp-3 whitespace-pre-line text-sm">{post.caption}</p>
      {post.mediaUrl ? (
        <a
          href={post.mediaUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate text-xs text-link-ink hover:underline"
        >
          {post.mediaUrl}
        </a>
      ) : null}
      {post.status === "FAILED" && post.result ? (
        <p role="alert" className="text-[13px] text-danger-ink">
          {post.result}
        </p>
      ) : null}
    </Card>
  );
}
