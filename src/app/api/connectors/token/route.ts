import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { hit } from "@/lib/rate-limit";
import { editorIsGranted, findProviderByCredentialType } from "@/lib/connectors/providers";
import { installationForKey } from "@/server/knowledge/keys";
import { ConnectorAuthError, getConnectorAccessToken } from "@/server/connector-tokens";

/**
 * A current access token for a tool an installed workflow is linked to, for a
 * template that needs to call the tool itself rather than through n8n's
 * credential. Authenticated by the installation's own key, like knowledge
 * search, and it answers only for connections that installation was built with.
 */
export async function POST(request: Request) {
  const installation = await installationForKey(request.headers.get("authorization"));
  if (!installation) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limiter = hit(`connector-token:${installation.id}`, { limit: 120, windowMs: 60_000 });
  if (!limiter.ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "retry-after": String(limiter.retryAfterSeconds) } },
    );
  }

  let body: { credentialType?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const credentialType = typeof body.credentialType === "string" ? body.credentialType : "";
  if (!findProviderByCredentialType(credentialType)) {
    return NextResponse.json({ error: "Unknown connector" }, { status: 404 });
  }

  const link = await prisma.installationCredential.findUnique({
    where: {
      installationId_credentialType: { installationId: installation.id, credentialType },
    },
  });
  if (!link?.connectorId) {
    return NextResponse.json({ error: "No connection for that tool on this installation" }, { status: 404 });
  }

  const provider = findProviderByCredentialType(credentialType)!;
  const source = provider.sourceCredentialType
    ? await prisma.connector.findUnique({ where: { id: link.connectorId } })
    : null;
  if (provider.sourceCredentialType && !editorIsGranted(provider, source?.secretJson ?? null)) {
    return NextResponse.json({ error: "reconnect" }, { status: 409 });
  }

  try {
    const accessToken = await getConnectorAccessToken(link.connectorId);
    return NextResponse.json(
      { access_token: accessToken, token_type: "bearer" },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ConnectorAuthError && error.permanent) {
      return NextResponse.json({ error: "reconnect" }, { status: 409 });
    }
    console.error("Connector token refresh failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "temporarily unavailable" }, { status: 503 });
  }
}

export const dynamic = "force-dynamic";
