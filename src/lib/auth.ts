import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import { prisma } from "./db";
import { readSession } from "./session";
import type { Role } from "@/generated/prisma";

export async function hashPassword(plain: string) {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string) {
  return bcrypt.compare(plain, hash);
}

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
