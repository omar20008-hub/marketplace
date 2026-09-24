import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Sidebar, type SidebarThread } from "@/components/app/sidebar";
import { timeOfDay } from "@/lib/readiness";

function groupFor(date: Date, now: Date) {
  const day = 86_400_000;
  const startOfToday = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  if (date.getTime() >= startOfToday) return "Today";
  if (date.getTime() >= startOfToday - day) return "Yesterday";
  return "Earlier";
}

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  const [threads, workspaceCount, attention] = await Promise.all([
    prisma.thread.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: "desc" },
      take: 12,
      select: { id: true, title: true, updatedAt: true },
    }),
    prisma.installation.count({
      where: { userId: user.id, status: { in: ["ACTIVE", "PARTIAL", "DISABLED"] } },
    }),
    prisma.connectedAccount.count({
      where: { userId: user.id, status: { in: ["EXPIRED", "PENDING"] } },
    }),
  ]);

  // The design anchors thread groups to the newest thread, not to the wall
  // clock, so seeded data still reads as "Today" and "Yesterday".
  const anchor = threads[0]?.updatedAt ?? new Date();

  const sidebarThreads: SidebarThread[] = threads.map((thread) => {
    const group = groupFor(thread.updatedAt, anchor);
    return {
      id: thread.id,
      title: thread.title,
      time: group === "Today" ? timeOfDay(thread.updatedAt) : "",
      group,
    };
  });

  return (
    <div className="flex h-dvh flex-col md:flex-row">
      <Sidebar
        user={{
          name: user.name,
          initials: user.initials,
          avatarTint: user.avatarTint,
          avatarInk: user.avatarInk,
          line: [user.orgName, user.plan.name, `${user.credits.toLocaleString()} credits`]
            .filter(Boolean)
            .join(" · "),
          isAdmin: user.roles.includes("ADMIN"),
          isCreator: user.roles.includes("CREATOR"),
        }}
        threads={sidebarThreads}
        counts={{
          workspace: workspaceCount,
          accountsNeedAttention: attention > 0,
        }}
      />
      <main className="min-w-0 flex-1 overflow-y-auto bg-canvas">{children}</main>
    </div>
  );
}
