import "server-only";
import { prisma } from "@/lib/db";
import { openCredential, sealCredential } from "@/lib/secrets";
import {
  DRIVE_READONLY_SCOPE,
  GOOGLE_DRIVE_CREDENTIAL,
  GoogleAuthError,
  refreshAccessToken,
  type TokenSet,
} from "@/lib/google-oauth";
import { refreshInstallationStates } from "./installation-state";
import { resumeKnowledgeSources } from "./knowledge/resume";

/**
 * A Google connection the platform holds — the half of "durable" that lives in
 * the database.
 *
 * What keeps it from quietly dying:
 *  - one refresh at a time per account (an advisory lock), so two workers that
 *    find a stale token do not both renew it and race to overwrite each other;
 *  - a rotated refresh token, if Google ever sends one, replaces the old one;
 *  - only invalid_grant expires an account. A network blip or a Google 5xx says
 *    nothing about the user's connection and must not disconnect them;
 *  - when it does expire, the account is marked EXPIRED, the dead token is
 *    dropped, and every installation that needed it says so in My workspace —
 *    a visible "reconnect", never a silent failure;
 *  - keepGoogleAccountsAlive() uses every token often enough that Google's
 *    six-months-unused rule never gets a chance to apply.
 */

const SKEW_MS = 60_000;
const IDLE_DAYS = 7;

type SaveResult =
  | { ok: true; accountId: string }
  | { ok: false; reason: "scope" | "no_refresh" };

export async function saveGoogleConnection({
  userId,
  email,
  tokens,
}: {
  userId: string;
  email: string;
  tokens: TokenSet;
}): Promise<SaveResult> {
  // The user can untick the Drive box on Google's consent screen. Without it
  // there is nothing to index, and it is better said now than at first sync.
  if (!tokens.scope.includes(DRIVE_READONLY_SCOPE)) {
    return { ok: false, reason: "scope" };
  }

  const existing = await prisma.connectedAccount.findUnique({
    where: {
      userId_credentialType_accountRef: {
        userId,
        credentialType: GOOGLE_DRIVE_CREDENTIAL,
        accountRef: email,
      },
    },
  });

  const previousRefresh = existing?.secretJson
    ? openCredential(existing.secretJson).refresh_token
    : undefined;
  const refreshToken = tokens.refreshToken ?? previousRefresh;
  if (!refreshToken) return { ok: false, reason: "no_refresh" };

  const secretJson = sealCredential({
    refresh_token: refreshToken,
    access_token: tokens.accessToken,
    scope: tokens.scope.join(" "),
  });

  // Updated in place when it is the same Google account, so reconnecting never
  // piles up refresh tokens — Google invalidates the oldest past a fixed number
  // per user and client.
  const account = await prisma.connectedAccount.upsert({
    where: {
      userId_credentialType_accountRef: {
        userId,
        credentialType: GOOGLE_DRIVE_CREDENTIAL,
        accountRef: email,
      },
    },
    create: {
      userId,
      credentialType: GOOGLE_DRIVE_CREDENTIAL,
      displayName: "Google Drive",
      initials: "GD",
      accountRef: email,
      status: "ACTIVE",
      reusable: true,
      secretJson,
      expiresAt: tokens.expiresAt,
    },
    update: { status: "ACTIVE", secretJson, expiresAt: tokens.expiresAt },
  });

  await refreshInstallationStates(userId);
  await resumeKnowledgeSources(account.id);
  return { ok: true, accountId: account.id };
}

async function readUsable(accountId: string): Promise<string | null> {
  const account = await prisma.connectedAccount.findUnique({ where: { id: accountId } });
  if (
    account?.status === "ACTIVE" &&
    account.secretJson &&
    account.expiresAt &&
    account.expiresAt.getTime() - Date.now() > SKEW_MS
  ) {
    return openCredential(account.secretJson).access_token ?? null;
  }
  return null;
}

/**
 * A usable access token for this account, renewing it if it is about to lapse.
 * Throws a permanent GoogleAuthError if the connection is dead (and has by then
 * been marked EXPIRED); any other error is transient and safe to retry.
 */
export async function getGoogleAccessToken(accountId: string): Promise<string> {
  const cached = await readUsable(accountId);
  if (cached) return cached;

  const outcome = await prisma.$transaction(
    async (tx) => {
      // Held to the end of the transaction. A second caller waits here, then
      // finds the token the first one just stored and uses it.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${accountId}))`;

      const account = await tx.connectedAccount.findUnique({ where: { id: accountId } });
      if (!account || account.status !== "ACTIVE" || !account.secretJson) {
        return { kind: "unavailable" as const, userId: account?.userId };
      }

      const secret = openCredential(account.secretJson);
      if (
        secret.access_token &&
        account.expiresAt &&
        account.expiresAt.getTime() - Date.now() > SKEW_MS
      ) {
        return { kind: "ok" as const, token: secret.access_token };
      }

      try {
        const fresh = await refreshAccessToken(secret.refresh_token);
        await tx.connectedAccount.update({
          where: { id: account.id },
          data: {
            secretJson: sealCredential({
              ...secret,
              refresh_token: fresh.refreshToken ?? secret.refresh_token,
              access_token: fresh.accessToken,
            }),
            expiresAt: fresh.expiresAt,
          },
        });
        return { kind: "ok" as const, token: fresh.accessToken };
      } catch (error) {
        if (error instanceof GoogleAuthError && error.permanent) {
          // Committed with the transaction, so the marking cannot be lost to
          // the throw that follows.
          await tx.connectedAccount.update({
            where: { id: account.id },
            data: { status: "EXPIRED", secretJson: null, expiresAt: null },
          });
          return { kind: "expired" as const, userId: account.userId, error };
        }
        throw error;
      }
    },
    { timeout: 30_000, maxWait: 10_000 },
  );

  if (outcome.kind === "ok") return outcome.token;

  if (outcome.userId) await refreshInstallationStates(outcome.userId);
  if (outcome.kind === "expired") throw outcome.error;
  throw new GoogleAuthError("This Google connection is not active.", "not_connected", true);
}

export type KeepAliveSummary = { checked: number; renewed: number; expired: number; failed: number };

/**
 * Renews any Google connection nobody has touched for a week. The access token
 * lasts an hour, so an expiresAt that old means the token has not been used
 * since — run this often enough and no account ever approaches the six months
 * of disuse after which Google drops a refresh token.
 */
export async function keepGoogleAccountsAlive(now = new Date()): Promise<KeepAliveSummary> {
  const cutoff = new Date(now.getTime() - IDLE_DAYS * 86_400_000);
  const idle = await prisma.connectedAccount.findMany({
    where: {
      credentialType: GOOGLE_DRIVE_CREDENTIAL,
      status: "ACTIVE",
      secretJson: { not: null },
      expiresAt: { lt: cutoff },
    },
    select: { id: true },
    take: 200,
  });

  const summary: KeepAliveSummary = { checked: idle.length, renewed: 0, expired: 0, failed: 0 };
  for (const { id } of idle) {
    try {
      await getGoogleAccessToken(id);
      summary.renewed++;
    } catch (error) {
      if (error instanceof GoogleAuthError && error.permanent) summary.expired++;
      else summary.failed++;
    }
  }
  return summary;
}
