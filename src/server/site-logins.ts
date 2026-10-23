import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { openCredential, sealCredential } from "@/lib/secrets";

/**
 * Website logins the personal assistant uses on the person's behalf.
 *
 * What is being held to:
 *  - a password is typed into the platform through a one-time link, never into
 *    a chat, and is stored sealed with SECRETS_KEY;
 *  - only fillSiteLogin() returns a password, and it is called by the server
 *    path that drives the browser, never by a page or a model;
 *  - the browser never reaches a private, loopback or link-local address, so
 *    the assistant cannot be pointed at the server's own network;
 *  - every save, use and delete is recorded in the audit log without the secret.
 */

const LINK_TTL_MS = 10 * 60 * 1000;
const MAX_USERNAME = 200;
const MAX_PASSWORD = 500;

export type SiteRef = { siteUrl: string; host: string };

/** Accepts a site as https://host[/path]. Refuses anything the browser must not open. */
export function normalizeSiteUrl(input: string): SiteRef | { error: string } {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { error: "Enter a full address, for example https://shop.example.com/login" };
  }
  if (url.protocol !== "https:") return { error: "Only https:// addresses can be saved." };
  if (url.port && url.port !== "443") return { error: "Only the standard https port can be saved." };
  if (url.username || url.password) return { error: "Do not put a login in the address." };

  const host = url.hostname.toLowerCase();
  if (!isPublicHostname(host)) return { error: "That address is not a public website." };

  return { siteUrl: `https://${host}${url.pathname}`, host };
}

/** Refuses names and literal addresses that point inside a network. */
export function isPublicHostname(host: string): boolean {
  if (!host.includes(".")) return false; // "localhost", "intranet", etc.
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false; // bare IPv4
  if (host.includes(":")) return false; // bare IPv6
  return true;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A one-time link for the person to type a login into the platform. */
export async function requestSiteLoginLink(
  { userId, siteUrl }: { userId: string; siteUrl: string },
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + LINK_TTL_MS);
  await prisma.siteLoginRequest.create({
    data: { userId, siteUrl, tokenHash: hashToken(token), expiresAt },
  });
  return { token, expiresAt };
}

export type LinkState =
  | { ok: true; siteUrl: string; host: string }
  | { ok: false; reason: "invalid" | "expired" | "used" | "not_yours" };

/** What the form page may show before the person types anything. */
export async function readSiteLoginLink(
  userId: string,
  token: string,
  now: Date = new Date(),
): Promise<LinkState> {
  const row = await prisma.siteLoginRequest.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!row) return { ok: false, reason: "invalid" };
  if (row.userId !== userId) return { ok: false, reason: "not_yours" };
  if (row.usedAt) return { ok: false, reason: "used" };
  if (row.expiresAt <= now) return { ok: false, reason: "expired" };
  const ref = normalizeSiteUrl(row.siteUrl);
  if ("error" in ref) return { ok: false, reason: "invalid" };
  return { ok: true, siteUrl: ref.siteUrl, host: ref.host };
}

/** Spends the link and stores the login. Replaces an earlier login for the same site and username. */
export async function saveSiteLogin(
  {
    userId,
    token,
    username,
    password,
  }: { userId: string; token: string; username: string; password: string },
  now: Date = new Date(),
): Promise<
  | { ok: true }
  | { ok: false; reason: "invalid" | "expired" | "used" | "not_yours" | "input" }
> {
  const user = username.trim();
  if (!user || user.length > MAX_USERNAME || !password || password.length > MAX_PASSWORD) {
    return { ok: false, reason: "input" };
  }

  const link = await readSiteLoginLink(userId, token, now);
  if (!link.ok) return link;

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.siteLoginRequest.updateMany({
      where: { tokenHash: hashToken(token), usedAt: null },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) return { ok: false, reason: "used" } as const;

    await tx.siteLogin.upsert({
      where: { userId_host_username: { userId, host: link.host, username: user } },
      create: {
        userId,
        siteUrl: link.siteUrl,
        host: link.host,
        username: user,
        sealedSecret: sealCredential({ password }),
      },
      update: { siteUrl: link.siteUrl, sealedSecret: sealCredential({ password }) },
    });
    await tx.auditLog.create({
      data: { actorId: userId, action: "site-login.saved", subject: link.host },
    });
    return { ok: true } as const;
  });
}

/** For the settings tab. Never includes a password. */
export async function listSiteLogins(userId: string) {
  return prisma.siteLogin.findMany({
    where: { userId },
    select: { id: true, host: true, siteUrl: true, username: true, createdAt: true, lastUsedAt: true },
    orderBy: [{ host: "asc" }, { username: "asc" }],
  });
}

export async function deleteSiteLogin(userId: string, id: string): Promise<boolean> {
  const row = await prisma.siteLogin.findFirst({ where: { id, userId }, select: { host: true } });
  if (!row) return false;
  await prisma.$transaction([
    prisma.siteLogin.delete({ where: { id } }),
    prisma.auditLog.create({
      data: { actorId: userId, action: "site-login.deleted", subject: row.host },
    }),
  ]);
  return true;
}

/**
 * Resolves one saved login by its id, for the personal assistant's fill path.
 * Only the owner's logins resolve: another person's id returns null.
 */
export async function resolveSiteLoginById(
  { userId, id }: { userId: string; id: string },
  now: Date = new Date(),
): Promise<{ username: string; password: string; host: string } | null> {
  const row = await prisma.siteLogin.findFirst({ where: { id, userId } });
  if (!row) return null;
  const secret = openCredential(row.sealedSecret);
  await prisma.$transaction([
    prisma.siteLogin.update({ where: { id: row.id }, data: { lastUsedAt: now } }),
    prisma.auditLog.create({
      data: { actorId: userId, action: "site-login.used", subject: row.host },
    }),
  ]);
  return { username: row.username, password: secret.password ?? "", host: row.host };
}

/**
 * The only place a saved password is read back. Called by the server path that
 * drives the browser, which types it into the login form and discards it.
 * Returns the one login for that site when no username is given, and null when
 * there is none or more than one and the caller did not say which.
 */
export async function fillSiteLogin(
  { userId, siteUrl, username }: { userId: string; siteUrl: string; username?: string },
  now: Date = new Date(),
): Promise<{ username: string; password: string } | { error: "none" | "ambiguous" | "invalid" }> {
  const ref = normalizeSiteUrl(siteUrl);
  if ("error" in ref) return { error: "invalid" };

  const rows = await prisma.siteLogin.findMany({
    where: { userId, host: ref.host, ...(username ? { username } : {}) },
  });
  if (rows.length === 0) return { error: "none" };
  if (rows.length > 1) return { error: "ambiguous" };

  const row = rows[0];
  const secret = openCredential(row.sealedSecret);
  await prisma.$transaction([
    prisma.siteLogin.update({ where: { id: row.id }, data: { lastUsedAt: now } }),
    prisma.auditLog.create({
      data: { actorId: userId, action: "site-login.used", subject: ref.host },
    }),
  ]);
  return { username: row.username, password: secret.password ?? "" };
}
