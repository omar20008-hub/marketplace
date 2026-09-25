import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth";
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

/**
 * No requireUser() here on purpose: this layout wraps the marketplace and the
 * home page, both of which a guest may browse. Every screen that actually
 * needs an account still calls requireUser() or requireRole() itself —
 * /workspace, /accounts, /creator, /admin, /marketplace/[slug]/setup,
 * /tasks/[id] all do, unchanged, which is what turns a guest's click on any
 * of them into the sign-in redirect it always was. This layout only has to
 * stop assuming there is a viewer to build a sidebar for.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await currentUser();

  const [threads, workspaceCount, attention] = user
    ? await Promise.all([
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
      ])
    : [[], 0, 0];

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
        user={
          user
            ? {
                name: user.name,
                initials: user.initials,
                avatarTint: user.avatarTint,
                avatarInk: user.avatarInk,
                line: [
                  user.orgName,
                  user.plan.name,
                  `${user.credits.toLocaleString()} credits`,
                ]
                  .filter(Boolean)
                  .join(" · "),
                isAdmin: user.roles.includes("ADMIN"),
                isCreator: user.roles.includes("CREATOR"),
              }
            : null
        }
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
