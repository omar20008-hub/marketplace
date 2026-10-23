import "server-only";
import { prisma } from "@/lib/db";
import { findProviderByCredentialType, type ConnectorProvider } from "@/lib/connectors/providers";
import { postToTokenEndpoint } from "@/lib/connectors/token-request";
import { openCredential, sealCredential } from "@/lib/secrets";
import { refreshInstallationStates } from "./installation-state";

/**
 * A usable access token for a connection made through the generic sign-in,
 * renewing it when it is about to lapse.
 *
 * The same rules as the Google path (server/google-account.ts): one refresh at
 * a time per connection, and only a refusal from the tool itself ends the
 * connection. A network failure or a 5xx says nothing about the person's
 * account, so it is reported as transient and the connection stays ACTIVE.
 */

const SKEW_MS = 60_000;

export class ConnectorAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = "ConnectorAuthError";
  }
}

type Answer = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };

async function refresh(provider: ConnectorProvider, refreshToken: string) {
  const response = await postToTokenEndpoint(provider, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const json = (await response.json().catch(() => null)) as Answer | null;

  if (!response.ok || !json?.access_token) {
    throw new ConnectorAuthError(
      `${provider.displayName} token refresh: ${json?.error ?? response.status}`,
      json?.error ?? String(response.status),
      json?.error === "invalid_grant",
    );
  }
  return { ...json, access_token: json.access_token };
}

/**
 * A token with no expiry (Notion's, Trello's) is usable for as long as the
 * connection is ACTIVE. The tool revokes it, and a revoked one fails at the
 * tool, which is where the connection is then marked for reconnecting.
 */
function notLapsing(expiresAt: Date | null): boolean {
  return !expiresAt || expiresAt.getTime() - Date.now() > SKEW_MS;
}

async function readUsable(connectorId: string): Promise<string | null> {
  const connector = await prisma.connector.findUnique({ where: { id: connectorId } });
  if (connector?.status === "ACTIVE" && connector.secretJson && notLapsing(connector.expiresAt)) {
    return openCredential(connector.secretJson).access_token ?? null;
  }
  return null;
}

export async function getConnectorAccessToken(connectorId: string): Promise<string> {
  const cached = await readUsable(connectorId);
  if (cached) return cached;

  const outcome = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${connectorId}))`;

      const connector = await tx.connector.findUnique({ where: { id: connectorId } });
      const provider = connector ? findProviderByCredentialType(connector.credentialType) : null;
      if (!connector || !provider || connector.status !== "ACTIVE" || !connector.secretJson) {
        return { kind: "unavailable" as const, userId: connector?.userId };
      }

      const secret = openCredential(connector.secretJson);
      if (secret.access_token && notLapsing(connector.expiresAt)) {
        return { kind: "ok" as const, token: secret.access_token };
      }

      if (!secret.refresh_token) {
        await tx.connector.update({
          where: { id: connector.id },
          data: { status: "EXPIRED", secretJson: null, expiresAt: null },
        });
        return {
          kind: "expired" as const,
          userId: connector.userId,
          error: new ConnectorAuthError("No refresh token was issued for this connection.", "no_refresh", true),
        };
      }

      try {
        const fresh = await refresh(provider, secret.refresh_token);
        await tx.connector.update({
          where: { id: connector.id },
          data: {
            secretJson: sealCredential({
              ...secret,
              access_token: fresh.access_token,
              refresh_token: fresh.refresh_token ?? secret.refresh_token,
            }),
            expiresAt: fresh.expires_in ? new Date(Date.now() + fresh.expires_in * 1000) : null,
          },
        });
        return { kind: "ok" as const, token: fresh.access_token };
      } catch (error) {
        if (error instanceof ConnectorAuthError && error.permanent) {
          await tx.connector.update({
            where: { id: connector.id },
            data: { status: "EXPIRED", secretJson: null, expiresAt: null },
          });
          return { kind: "expired" as const, userId: connector.userId, error };
        }
        throw error;
      }
    },
    { timeout: 30_000, maxWait: 10_000 },
  );

  if (outcome.kind === "ok") return outcome.token;
  if (outcome.userId) await refreshInstallationStates(outcome.userId);
  if (outcome.kind === "expired" && outcome.error) throw outcome.error;
  throw new ConnectorAuthError("This connection is no longer active.", "not_connected", true);
}
