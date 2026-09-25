import Link from "next/link";
import { Check } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { env } from "@/lib/env";
import {
  Avatar,
  Badge,
  Button,
  Card,
  FootNote,
  Mono,
  PageTitle,
  SectionLabel,
  Table,
  Td,
  Th,
} from "@/components/ds";
import { formatDate, waitingFor } from "@/lib/readiness";
import { toggleRole } from "@/server/admin-actions";
import { CreateUserForm } from "./create-user-form";
import { DecisionPanel } from "./decision-panel";

export const metadata = { title: "Admin · Builder" };

/** Only "submissions" and "users" go anywhere; the rest are the design's
 * placeholders for screens nothing here builds yet, same as before this tab
 * existed — inert, not broken. */
const TABS = [
  { key: "submissions", label: "Submissions" },
  { key: "products", label: "Products" },
  { key: "health", label: "Health" },
  { key: "plans", label: "Plans" },
  { key: "audit", label: "Audit" },
  { key: "users", label: "Users" },
] as const;

function AdminTabs({ active, openCount }: { active: string; openCount?: number }) {
  return (
    <nav className="mt-4 flex gap-1 overflow-x-auto text-sm">
      {TABS.map((tab) => {
        const linkable = tab.key === "submissions" || tab.key === "users";
        const isActive = tab.key === active;
        const className = isActive
          ? "flex items-center gap-1.5 rounded-full bg-fill px-3.5 py-[7px] font-medium whitespace-nowrap text-ink"
          : "rounded-full px-3.5 py-[7px] whitespace-nowrap text-ink-3";
        const content = (
          <>
            {tab.label}
            {tab.key === "submissions" && openCount !== undefined ? (
              <span className="text-xs text-ink-3">{openCount}</span>
            ) : null}
          </>
        );
        return linkable ? (
          <Link
            key={tab.key}
            href={tab.key === "submissions" ? "/admin" : `/admin?view=${tab.key}`}
            className={className}
          >
            {content}
          </Link>
        ) : (
          <span key={tab.key} className={className}>
            {content}
          </span>
        );
      })}
    </nav>
  );
}

type Filter = "review" | "passed" | "failed";

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: Filter; submission?: string; view?: string }>;
}) {
  const { filter = "review", submission: submissionId, view = "submissions" } =
    await searchParams;
  const admin = await requireRole("ADMIN");

  if (view === "users") {
    const [users, plans] = await Promise.all([
      prisma.user.findMany({
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          email: true,
          name: true,
          roles: true,
          initials: true,
          avatarTint: true,
          avatarInk: true,
          createdAt: true,
        },
      }),
      prisma.plan.findMany({ orderBy: { priceMonthly: "asc" } }),
    ]);

    return (
      <div className="px-5 py-5 lg:px-7">
        <PageTitle title="Admin" />
        <AdminTabs active="users" />

        <div className="mt-5">
          <SectionLabel>New account</SectionLabel>
          <div className="mt-2.5">
            <CreateUserForm plans={plans} />
          </div>
        </div>

        <UsersTable users={users} currentUserId={admin.id} />
      </div>
    );
  }

  const [open, products, installations, audit] = await Promise.all([
    prisma.submission.findMany({
      where: { state: { in: ["UNDER_REVIEW", "VALIDATION_FAILED"] } },
      include: {
        product: true,
        creator: { include: { _count: { select: { products: true } } } },
        issues: true,
      },
      orderBy: { submittedAt: "asc" },
    }),
    prisma.product.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.installation.count({ where: { status: "DISABLED" } }),
    prisma.auditLog.findMany({
      include: { actor: true },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
  ]);

  const needsHuman = open.filter(
    (item) =>
      item.state === "UNDER_REVIEW" &&
      item.issues.some((issue) => issue.severity === "HUMAN_REVIEW"),
  );
  const autoPassed = open.filter(
    (item) => item.state === "UNDER_REVIEW" && item.issues.length === 0,
  );
  const autoFailed = open.filter((item) => item.state === "VALIDATION_FAILED");

  const bucket =
    filter === "passed" ? autoPassed : filter === "failed" ? autoFailed : needsHuman;

  const selected =
    open.find((item) => item.id === submissionId) ?? bucket[0] ?? open[0];

  const countFor = (status: string) =>
    products.find((row) => row.status === status)?._count._all ?? 0;

  const FILTERS: { key: Filter; label: string; count: number }[] = [
    { key: "review", label: "Needs human review", count: needsHuman.length },
    { key: "passed", label: "Auto-passed", count: autoPassed.length },
    { key: "failed", label: "Auto-failed", count: autoFailed.length },
  ];

  return (
    <div className="px-5 py-5 lg:px-7">
      <PageTitle title="Admin" />

      <AdminTabs active="submissions" openCount={open.length} />

      <div className="mt-5 grid grid-cols-1 gap-7 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((item) => (
              <Link
                key={item.key}
                href={`/admin?filter=${item.key}`}
                className={
                  item.key === filter
                    ? "rounded-full bg-ink px-3 py-1.5 text-[13px] text-white"
                    : "rounded-full border border-line px-3 py-1.5 text-[13px] hover:bg-fill"
                }
              >
                {item.label} · {item.count}
              </Link>
            ))}
          </div>

          <div className="mt-4">
            <Table>
              <thead>
                <tr>
                  <Th>Submission</Th>
                  <Th>Creator</Th>
                  <Th>Automated checks</Th>
                  <Th>Flags</Th>
                  <Th>Waiting</Th>
                </tr>
              </thead>
              <tbody>
                {bucket.map((item) => {
                  const clean = item.issues.length === 0;
                  return (
                    <tr
                      key={item.id}
                      className={selected?.id === item.id ? "bg-fill/60" : undefined}
                    >
                      <Td>
                        <Link
                          href={`/admin?filter=${filter}&submission=${item.id}`}
                          className="text-ink hover:underline"
                        >
                          {item.product.title} v{item.version}
                        </Link>
                        <div className="mt-0.5 text-xs text-ink-3">
                          {item.product.kind === "AGENT" ? "Agent" : "Workflow"}
                        </div>
                      </Td>
                      <Td className="whitespace-nowrap text-ink-2">
                        {item.creator.creatorName ?? item.creator.name}
                        {!item.creator.creatorVerified ? (
                          <span className="text-ink-3"> · unverified</span>
                        ) : null}
                      </Td>
                      <Td className="whitespace-nowrap">
                        {item.state === "VALIDATION_FAILED" ? (
                          <span className="text-danger-ink">
                            {item.issues.filter((i) => i.severity === "BLOCKER").length}{" "}
                            blocker
                          </span>
                        ) : clean ? (
                          <span className="inline-flex items-center gap-1.5 text-ready-ink">
                            <Check size={14} strokeWidth={2.2} />
                            All passed
                          </span>
                        ) : (
                          <span className="text-warn-ink">Needs a look</span>
                        )}
                      </Td>
                      <Td className="text-ink-2">
                        {item.issues.length > 0
                          ? item.issues.map((issue) => issue.title).join(", ")
                          : "—"}
                      </Td>
                      <Td>
                        <Mono>{waitingFor(item.submittedAt)}</Mono>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>

            {bucket.length === 0 ? (
              <p className="py-12 text-center text-sm text-ink-3">
                Nothing in this bucket.
              </p>
            ) : null}
          </div>

          <div className="mt-8">
            <SectionLabel>Published health · last 24h</SectionLabel>
            <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Active" value={countFor("PUBLISHED")} />
              <Stat label="Restricted" value={countFor("RESTRICTED")} tone="partial" />
              <Stat
                label="Suspended"
                value={countFor("SECURITY_HOLD") + countFor("SUSPENDED")}
                tone="blocked"
              />
              <Stat label="Auto-disabled installs" value={installations} tone="partial" />
            </div>
          </div>

          {audit.length > 0 ? (
            <div className="mt-8">
              <SectionLabel>Recent decisions</SectionLabel>
              <div className="mt-2.5 flex flex-col">
                {audit.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex flex-wrap items-baseline gap-2 border-b border-selected py-2 text-[13px]"
                  >
                    <span className="font-medium">{entry.actor.name}</span>
                    <span className="text-ink-2">{entry.action}</span>
                    <span>{entry.subject}</span>
                    <span className="ml-auto truncate text-xs text-ink-3">
                      {entry.reason}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        {selected ? (
          <aside className="flex flex-col gap-4">
            <Card className="flex flex-col gap-4 p-4">
              <div>
                <SectionLabel>Decision</SectionLabel>
                <div className="mt-1.5 text-[15px] font-semibold">
                  {selected.product.title} v{selected.version}
                </div>
                <p className="mt-0.5 text-xs text-ink-3">
                  {selected.creator.creatorName ?? selected.creator.name} ·{" "}
                  {selected.creator._count.products} product
                  {selected.creator._count.products === 1 ? "" : "s"} · 0 incidents
                </p>
              </div>

              <div>
                <SectionLabel className="text-ink-3">
                  What the automation found
                </SectionLabel>
                <ul className="mt-2 flex flex-col gap-2 text-[13px]">
                  {selected.issues.length === 0 ? (
                    <li className="text-ink-2">
                      Every automated check passed. Nothing was flagged.
                    </li>
                  ) : (
                    selected.issues.map((issue) => (
                      <li key={issue.id} className="flex flex-col gap-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span>{issue.title}</span>
                          <Badge
                            tone={
                              issue.severity === "BLOCKER"
                                ? "blocked"
                                : issue.severity === "FIXED"
                                  ? "ready"
                                  : "partial"
                            }
                          >
                            {issue.severity.toLowerCase().replace(/_/g, " ")}
                          </Badge>
                        </span>
                        {issue.answer ? (
                          <span className="rounded-row bg-fill p-2 text-ink-2">
                            Creator: {issue.answer}
                          </span>
                        ) : null}
                      </li>
                    ))
                  )}
                </ul>
              </div>

              {selected.product.n8nWorkflowId ? (
                <a
                  href={
                    env.n8n.baseUrl
                      ? `${env.n8n.baseUrl.replace(/\/api\/v1\/?$/, "")}/workflow/${selected.product.n8nWorkflowId}`
                      : "#"
                  }
                  target="_blank"
                  rel="noreferrer"
                  className="text-[13px]"
                >
                  Full payload and diff in n8n →
                </a>
              ) : null}

              <DecisionPanel
                submissionId={selected.id}
                hasBlocker={selected.issues.some(
                  (issue) => issue.severity === "BLOCKER",
                )}
              />

              <FootNote>
                Every decision is written to the audit log with your name and
                reason. Approval publishes this version only.
              </FootNote>
            </Card>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "partial" | "blocked";
}) {
  return (
    <Card className="p-3">
      <div className="text-xs text-ink-3">{label}</div>
      <div
        className={
          tone === "blocked"
            ? "mt-1 text-[22px] font-semibold text-danger-ink"
            : tone === "partial"
              ? "mt-1 text-[22px] font-semibold text-warn-ink"
              : "mt-1 text-[22px] font-semibold"
        }
      >
        {value}
      </div>
    </Card>
  );
}

type ManagedUser = {
  id: string;
  email: string;
  name: string;
  roles: string[];
  initials: string;
  avatarTint: string;
  avatarInk: string;
  createdAt: Date;
};

/**
 * Every row's two buttons post straight to toggleRole() — no client state,
 * because there is nothing to hold: the server re-reads the account's current
 * roles and flips the one requested, rather than trusting a hidden field for
 * what it already was.
 */
function UsersTable({
  users,
  currentUserId,
}: {
  users: ManagedUser[];
  currentUserId: string;
}) {
  const adminCount = users.filter((u) => u.roles.includes("ADMIN")).length;

  return (
    <div className="mt-5">
      <Table>
        <thead>
          <tr>
            <Th>User</Th>
            <Th>Roles</Th>
            <Th>Joined</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {users.map((user) => {
            const isCreator = user.roles.includes("CREATOR");
            const isAdmin = user.roles.includes("ADMIN");
            const isSelf = user.id === currentUserId;
            const isLastAdmin = isAdmin && adminCount <= 1;
            const adminDisabled = isAdmin && (isSelf || isLastAdmin);

            return (
              <tr key={user.id}>
                <Td>
                  <div className="flex items-center gap-2.5">
                    <Avatar
                      initials={user.initials}
                      tint={user.avatarTint}
                      ink={user.avatarInk}
                      size={28}
                    />
                    <div>
                      <div className="text-sm font-medium">
                        {user.name}
                        {isSelf ? (
                          <span className="text-ink-3"> · you</span>
                        ) : null}
                      </div>
                      <div className="text-xs text-ink-3">{user.email}</div>
                    </div>
                  </div>
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge tone="neutral">User</Badge>
                    {isCreator ? <Badge tone="platform">Creator</Badge> : null}
                    {isAdmin ? <Badge tone="ready">Admin</Badge> : null}
                  </div>
                </Td>
                <Td className="whitespace-nowrap text-ink-2">
                  <Mono>{formatDate(user.createdAt)}</Mono>
                </Td>
                <Td>
                  <div className="flex flex-wrap justify-end gap-1.5">
                    <form action={toggleRole}>
                      <input type="hidden" name="userId" value={user.id} />
                      <input type="hidden" name="role" value="CREATOR" />
                      <Button type="submit" tone={isCreator ? "danger" : "secondary"} size="sm">
                        {isCreator ? "Revoke creator" : "Grant creator"}
                      </Button>
                    </form>
                    <form action={toggleRole}>
                      <input type="hidden" name="userId" value={user.id} />
                      <input type="hidden" name="role" value="ADMIN" />
                      <Button
                        type="submit"
                        tone={adminDisabled ? "quiet" : isAdmin ? "danger" : "secondary"}
                        size="sm"
                        disabled={adminDisabled}
                        title={
                          isAdmin && isSelf
                            ? "You cannot remove your own admin access here."
                            : isAdmin && isLastAdmin
                              ? "At least one admin must remain."
                              : undefined
                        }
                      >
                        {isAdmin ? "Revoke admin" : "Grant admin"}
                      </Button>
                    </form>
                  </div>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>

      {users.length === 0 ? (
        <p className="py-12 text-center text-sm text-ink-3">No accounts yet.</p>
      ) : null}

      <div className="mt-4">
        <FootNote>
          Granting Creator or Admin, and revoking either, is written to the
          audit log under the Submissions tab.
        </FootNote>
      </div>
    </div>
  );
}
