import "server-only";
import { prisma } from "@/lib/db";
import { sealCredential } from "@/lib/secrets";
import {
  FACEBOOK_CREDENTIAL,
  hasRequiredScopes,
  type FacebookProfile,
  type LongLivedToken,
} from "@/lib/facebook-oauth";
import { refreshInstallationStates } from "./installation-state";

/**
 * The Facebook & Instagram connection made by "Continue with Facebook".
 *
 * It is the same ConnectedAccount a pasted token makes — one row per user for
 * this credential type, secret `{ accessToken }` and nothing else (n8n's
 * credential body refuses extra fields) — so installing a product needs no
 * special case. The one difference is expiresAt: a pasted token has none, this
 * one has the 60 days Facebook gave it.
 */

type SaveResult = { ok: true; accountId: string } | { ok: false; reason: "scope" | "no_pages" };

export async function saveFacebookConnection({
  userId,
  profile,
  token,
}: {
  userId: string;
  profile: FacebookProfile;
  token: LongLivedToken;
}): Promise<SaveResult> {
  // Facebook lets the person untick permissions on its own screen. Said now, not
  // at the first post.
  if (!hasRequiredScopes(profile.granted)) return { ok: false, reason: "scope" };
  if (profile.pages.length === 0) return { ok: false, reason: "no_pages" };

  // Posts go to the first Page the account manages (that is what the product
  // does), so that is the one named here.
  const accountRef = `${profile.name || "Facebook"} · ${profile.pages[0].name}`;
  const secretJson = sealCredential({ accessToken: token.accessToken });

  // Replaced in place: signing in again because a connection expired means
  // replacing it, not collecting another next to it.
  const existing = await prisma.connectedAccount.findFirst({
    where: { userId, credentialType: FACEBOOK_CREDENTIAL },
    orderBy: { createdAt: "asc" },
  });

  const account = existing
    ? await prisma.connectedAccount.update({
        where: { id: existing.id },
        data: { status: "ACTIVE", secretJson, expiresAt: token.expiresAt, accountRef },
      })
    : await prisma.connectedAccount.create({
        data: {
          userId,
          credentialType: FACEBOOK_CREDENTIAL,
          displayName: "Facebook & Instagram",
          initials: "FB",
          accountRef,
          status: "ACTIVE",
          reusable: true,
          secretJson,
          expiresAt: token.expiresAt,
        },
      });

  await refreshInstallationStates(userId);
  return { ok: true, accountId: account.id };
}

/**
 * Facebook tokens cannot be renewed in the background, so when one runs out the
 * connection is marked expired — a visible "Reconnect" on Connected accounts and
 * a note on the product — instead of every post failing with Facebook's message.
 * Only connections with a recorded lifetime are touched; a pasted token has none.
 */
export async function expireFacebookAccounts(now = new Date()): Promise<number> {
  const lapsed = await prisma.connectedAccount.findMany({
    where: {
      credentialType: FACEBOOK_CREDENTIAL,
      status: "ACTIVE",
      expiresAt: { lt: now },
    },
    select: { id: true, userId: true },
    take: 200,
  });
  if (lapsed.length === 0) return 0;

  await prisma.connectedAccount.updateMany({
    where: { id: { in: lapsed.map((account) => account.id) } },
    data: { status: "EXPIRED", secretJson: null, expiresAt: null },
  });
  for (const userId of new Set(lapsed.map((account) => account.userId))) {
    await refreshInstallationStates(userId);
  }
  return lapsed.length;
}
