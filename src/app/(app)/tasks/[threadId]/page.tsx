import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { FootNote, Mono } from "@/components/ds";
import { RunCard, type RunCardData } from "@/components/app/run-card";
import { FollowUp } from "@/components/app/follow-up";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const { threadId } = await params;
  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    select: { title: true },
  });
  return { title: thread ? `${thread.title} · Builder` : "Builder" };
}

export default async function ThreadPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const { threadId } = await params;
  const user = await requireUser();

  const thread = await prisma.thread.findFirst({
    where: { id: threadId, userId: user.id },
    include: {
      messages: { orderBy: { createdAt: "asc" } },
      runs: {
        include: {
          steps: { orderBy: { idx: "asc" } },
          artifacts: true,
          product: true,
        },
        orderBy: { startedAt: "asc" },
      },
    },
  });

  if (!thread) notFound();

  const runsById = new Map(thread.runs.map((run) => [run.id, run]));
  const latestRun = thread.runs.at(-1);

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-selected px-5 py-3">
        <h1 className="text-base font-medium">{thread.title}</h1>
        {latestRun ? <Mono>Run {latestRun.runId}</Mono> : null}
        <div className="ml-auto flex items-center gap-4 text-[13px] text-ink-2">
          <span>Runs in background</span>
          <button type="button" className="text-link hover:text-link-strong">
            Save as task
          </button>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col gap-5 px-5 py-6">
        {thread.messages.map((message) => {
          const run = message.runId ? runsById.get(message.runId) : undefined;
          return (
            <div key={message.id} className="flex flex-col gap-4">
              {message.role === "USER" ? (
                <div className="self-end rounded-card rounded-br-[6px] bg-fill px-4 py-2.5 text-[15px]">
                  {message.body}
                </div>
              ) : (
                <p className="text-[15px] leading-relaxed">{message.body}</p>
              )}
              {run ? <RunCard run={run as unknown as RunCardData} /> : null}
            </div>
          );
        })}
      </div>

      <div className="sticky bottom-0 border-t border-selected bg-canvas px-5 pt-4 pb-5">
        <div className="mx-auto w-full max-w-[760px]">
          <FollowUp threadId={thread.id} />
          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
            <Mono>Model: auto</Mono>
            <FootNote>
              Runs that fail because of us are never counted against your plan.
            </FootNote>
          </div>
        </div>
      </div>
    </div>
  );
}
