import "server-only";
import { prisma } from "@/lib/db";
import type { CredentialRule, NodeVerdict } from "./template-upload";

/**
 * The upload policy as the platform keeps it: which node types a template may use,
 * and which credential types can be kept. Shaped for validateUpload().
 */
export async function loadUploadRules(): Promise<{
  nodeRules: Record<string, NodeVerdict>;
  credRules: Record<string, CredentialRule>;
}> {
  const [nodes, credentials] = await Promise.all([
    prisma.nodeRule.findMany(),
    prisma.credentialRule.findMany(),
  ]);

  return {
    nodeRules: Object.fromEntries(nodes.map((n) => [n.nodeType, n.verdict as NodeVerdict])),
    credRules: Object.fromEntries(
      credentials.map((c) => [
        c.credentialType,
        {
          durability: c.durability,
          registered: c.appRegistered,
          authFlow: c.authFlow ?? "",
          flowReady: c.flowReady === true,
          note: c.note,
        },
      ]),
    ),
  };
}
