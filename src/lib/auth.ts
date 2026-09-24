import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { prisma } from "./db";
import { readSession } from "./session";
import type { Role } from "@/generated/prisma";

/**
 * Re-exported from lib/password.ts, which has no `server-only` and so can be
 * loaded by scripts/create-admin.ts. Both sides of a password — the script that
 * writes the first hash and the form that checks it — have to be the same
 * function, or they diverge the day someone changes the cost factor in one.
 */
export { hashPassword, verifyPassword } from "./password";

/**
 * Cached per request, so a page that reads the viewer in six places still makes
 * one query.
 */
export const currentUser = cache(async () => {
  const session = await readSession();
  if (!session) return null;

  return prisma.user.findUnique({
    where: { id: session.userId },
    include: { plan: true },
  });
});

export type Viewer = NonNullable<Awaited<ReturnType<typeof currentUser>>>;

export async function requireUser(): Promise<Viewer> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireRole(role: Role): Promise<Viewer> {
  const user = await requireUser();
  if (!user.roles.includes(role)) redirect("/");
  return user;
}

export function has(user: { roles: Role[] } | null, role: Role) {
  return Boolean(user?.roles.includes(role));
}
