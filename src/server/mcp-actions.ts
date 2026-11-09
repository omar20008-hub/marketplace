"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { sealCredential } from "@/lib/secrets";
import { listTools, McpError } from "@/lib/mcp/client";
import { MAX_MCP_SERVERS, MCP_CREDENTIAL } from "@/lib/mcp/naming";
import { assertPublicHttpsUrl, UnsafeUrlError } from "@/lib/mcp/safe-url";
import { forgetTools } from "./mcp-gateway";

/**
 * Connecting an MCP server from the Connectors page. The address and token are
 * checked by asking the server for its tools before anything is saved, so a wrong
 * address or token is said so here rather than found out by an agent later.
 */

export type McpConnectState = {
  error?: string;
  done?: boolean;
  message?: string;
  /** What was typed, sent back on an error so the form keeps it. Never the token. */
  values?: { name: string; url: string };
};

const MAX_NAME_CHARS = 40;
const MAX_TOKEN_CHARS = 4000;

const unsafeText: Record<UnsafeUrlError["reason"], string> = {
  scheme: "Use an https:// address.",
  credentials: "Leave the user name and password out of the address; put the token in the token field.",
  query: "Leave the ?query and #fragment out of the address; put the token in the token field.",
  port: "Only the standard https port is allowed.",
  host: "That address points inside a private network, which cannot be connected.",
  private: "That address points inside a private network, which cannot be connected.",
  unresolved: "That address could not be found. Check the spelling.",
};

const failureText: Record<McpError["code"], string> = {
  unsafe: "That address cannot be connected.",
  unreachable: "The server could not be reached. Check the address.",
  unauthorized: "The server did not accept the access token.",
  protocol: "That address did not answer as an MCP server.",
  too_large: "The server's answer was too large to use.",
  timeout: "The server took too long to answer.",
};

export async function connectMcpServer(_prev: McpConnectState, formData: FormData): Promise<McpConnectState> {
  const user = await requireUser();
  const name = String(formData.get("name") ?? "").replace(/\s+/g, " ").trim();
  const rawUrl = String(formData.get("url") ?? "").trim();
  const bearer = String(formData.get("token") ?? "").trim();
  const reusable = String(formData.get("reusable") ?? "all") === "all";
  const fail = (error: string): McpConnectState => ({ error, values: { name, url: rawUrl } });

  if (!name || name.length > MAX_NAME_CHARS) {
    return fail(`Give the server a name, up to ${MAX_NAME_CHARS} characters.`);
  }
  if (!rawUrl) return fail("Enter the server's address.");
  if (bearer.length > MAX_TOKEN_CHARS) return fail("That access token is too long.");

  let url: URL;
  try {
    url = await assertPublicHttpsUrl(rawUrl);
  } catch (error) {
    if (error instanceof UnsafeUrlError) return fail(unsafeText[error.reason]);
    throw error;
  }
  const accountRef = `${url.origin}${url.pathname}`;

  const existing = await prisma.connector.findMany({
    where: { userId: user.id, credentialType: MCP_CREDENTIAL, status: { not: "REVOKED" } },
    select: { accountRef: true },
  });
  if (existing.length >= MAX_MCP_SERVERS && !existing.some((c) => c.accountRef === accountRef)) {
    return fail(`You can connect at most ${MAX_MCP_SERVERS} MCP servers. Remove one first.`);
  }

  let toolCount: number;
  try {
    toolCount = (await listTools({ url: accountRef, bearer: bearer || undefined })).length;
  } catch (error) {
    if (error instanceof McpError) return fail(failureText[error.code]);
    throw error;
  }

  const secretJson = sealCredential({ url: accountRef, ...(bearer ? { bearer } : {}) });
  const connector = await prisma.connector.upsert({
    where: {
      userId_credentialType_accountRef: { userId: user.id, credentialType: MCP_CREDENTIAL, accountRef },
    },
    create: {
      userId: user.id,
      credentialType: MCP_CREDENTIAL,
      displayName: name,
      initials: name.slice(0, 2).toUpperCase(),
      accountRef,
      status: "ACTIVE",
      reusable,
      secretJson,
    },
    update: { displayName: name, status: "ACTIVE", reusable, secretJson, expiresAt: null },
  });
  forgetTools(connector.id);

  revalidatePath("/accounts");
  return { done: true, message: `Connected. ${toolCount} ${toolCount === 1 ? "tool" : "tools"} found.` };
}
