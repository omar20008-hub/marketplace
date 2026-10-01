import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Card, FootNote, PageTitle, SectionLabel } from "@/components/ds";
import { oauthStartUrl } from "@/lib/credentials";
import { relativeDays } from "@/lib/readiness";
import { processingStalled } from "@/server/knowledge/heartbeat";
import { knowledgeUsage } from "@/server/knowledge/limits";
import { AttachFolder, AutoRefresh, FileRow, SourceActions, SourceStatus } from "./parts";

export const metadata = { title: "Files · Builder" };

export default async function FilesPage({
  params,
}: {
  params: Promise<{ installationId: string }>;
}) {
  const { installationId } = await params;
  const user = await requireUser();

  const installation = await prisma.installation.findFirst({
    where: { id: installationId, userId: user.id, status: { not: "UNINSTALLED" } },
    include: {
      product: { select: { title: true, usesKnowledge: true } },
      knowledgeSources: {
        include: { files: { orderBy: [{ status: "asc" }, { name: "asc" }], take: 500 } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!installation || !installation.product.usesKnowledge) notFound();

  const drive = await prisma.connectedAccount.findFirst({
    where: { userId: user.id, credentialType: "googleDriveOAuth2Api" },
  });
  const jobs = await prisma.knowledgeJob.count({
    where: { targetId: { in: installation.knowledgeSources.map((s) => s.id) } },
  });

  const usage = await knowledgeUsage(user.id);
  // Work is queued and nothing has come to run it. Only then does the page say so;
  // while the worker is alive this changes nothing on screen.
  const stalled = await processingStalled(installation.knowledgeSources.map((s) => s.id));

  const busy =
    jobs > 0 ||
    installation.knowledgeSources.some((s) =>
      s.files.some((f) => f.status === "PENDING" || f.status === "INDEXING"),
    );

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
          title={`Files · ${installation.product.title}`}
          meta="What this assistant can read. It answers only from these files, and only yours."
        />
      </div>

      {stalled ? (
        <p
          role="alert"
          className="rounded-card bg-warn-tint px-4 py-3 text-[13px] leading-relaxed text-warn-ink"
        >
          Processing has not started. The scheduled worker that reads your files may be
          stopped, so they will stay on &ldquo;Syncing&rdquo; until it runs again. Ask the
          platform administrator to check it.
        </p>
      ) : null}

      {installation.knowledgeSources.length === 0 ? (
        <section className="flex flex-col gap-3">
          <SectionLabel>Choose a folder</SectionLabel>
          {drive?.status === "ACTIVE" ? (
            <AttachFolder installationId={installation.id} />
          ) : (
            <Card className="flex flex-wrap items-center gap-3 p-4">
              <p className="min-w-0 flex-1 text-[13px] text-ink-2">
                {drive?.status === "EXPIRED"
                  ? "Your Google Drive connection expired. Reconnect it to choose a folder."
                  : "Connect Google Drive to choose a folder."}
              </p>
              <a
                href={oauthStartUrl(`/workspace/${installation.id}/files`)}
                className="rounded-full bg-ink px-3.5 py-1.5 text-[13px] font-medium text-canvas"
              >
                {drive?.status === "EXPIRED" ? "Reconnect" : "Connect"}
              </a>
            </Card>
          )}
        </section>
      ) : (
        installation.knowledgeSources.map((source) => {
          const counts = { ready: 0, pending: 0, failed: 0, skipped: 0 };
          for (const file of source.files) {
            if (file.status === "READY") counts.ready++;
            else if (file.status === "PENDING" || file.status === "INDEXING") counts.pending++;
            else if (file.status === "FAILED") counts.failed++;
            else if (file.status === "UNSUPPORTED") counts.skipped++;
          }
          const visible = source.files.filter((f) => f.status !== "REMOVED");
          return (
            <section key={source.id} className="flex flex-col gap-3">
              <Card className="flex flex-col gap-3 p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{source.folderName}</div>
                    <div className="mt-0.5 text-xs text-ink-3">
                      Google Drive
                      {source.lastSyncedAt
                        ? ` · checked ${relativeDays(source.lastSyncedAt)}`
                        : " · not checked yet"}
                    </div>
                  </div>
                  <SourceStatus status={source.status} busy={busy} failed={counts.failed} />
                </div>

                <p className="text-[13px] text-ink-2">
                  {counts.ready} ready
                  {counts.pending ? ` · ${counts.pending} being read` : ""}
                  {counts.failed ? ` · ${counts.failed} failed` : ""}
                  {counts.skipped ? ` · ${counts.skipped} skipped` : ""}
                </p>

                {source.status === "NEEDS_RECONNECT" ? (
                  <p role="alert" className="text-[13px] text-danger-ink">
                    Your Google connection stopped working, so this folder is not being
                    kept up to date.{" "}
                    <a
                      href={oauthStartUrl(`/workspace/${installation.id}/files`)}
                      className="font-medium underline"
                    >
                      Reconnect
                    </a>
                  </p>
                ) : source.lastError ? (
                  <p className="text-[13px] text-warn-ink">{source.lastError}</p>
                ) : null}

                <SourceActions sourceId={source.id} folderName={source.folderName} paused={source.status === "PAUSED"} />
              </Card>

              {visible.length > 0 ? (
                <ul className="overflow-hidden rounded-card border border-selected">
                  {visible.map((file) => (
                    <FileRow
                      key={file.id}
                      file={{
                        id: file.id,
                        name: file.name,
                        path: file.path,
                        url: file.webUrl,
                        status: file.status,
                        error: file.error,
                        chunks: file.chunkCount,
                      }}
                    />
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-ink-3">
                  {busy ? "Looking through the folder…" : "This folder has no files yet."}
                </p>
              )}
            </section>
          );
        })
      )}

      <p className="text-xs text-ink-3">
        {usage.files.toLocaleString()} of {usage.maxFiles.toLocaleString()} files and{" "}
        {usage.sources} of {usage.maxSources} folder{usage.maxSources === 1 ? "" : "s"} used on
        your {usage.planName} plan.
      </p>

      <FootNote>
        Files are read-only and never modified. Add or edit a file in the folder and
        it appears here within moments; remove the folder here and everything indexed
        from it is deleted.
      </FootNote>
    </div>
  );
}
