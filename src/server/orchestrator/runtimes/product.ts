import type { Viewer } from "@/lib/auth";
import type { DispatchOutput } from "@/lib/n8n";
import { executeRun } from "@/server/run-engine";

/**
 * Runs one installed product on behalf of the Orchestrator. The same path as the
 * Run button, so readiness, the plan allowance and ownership are checked here, and
 * a refusal costs the user nothing.
 *
 * Returns the JSON the system prompt describes: the dispatcher's own reply shape
 * (success, incomplete, denied or error), so the model sees the same words it
 * always has.
 */
export async function runInstalledProduct({
  user,
  installationId,
  args,
  threadId,
}: {
  user: Viewer;
  installationId: string;
  args: Record<string, unknown>;
  threadId?: string;
}): Promise<string> {
  const seen: { reply?: DispatchOutput } = {};
  const run = await executeRun({
    user,
    installationId,
    args,
    threadId,
    onDispatch: (reply) => {
      seen.reply = reply;
    },
  });

  if (!run) return JSON.stringify({ result: "denied", reason: "installation_not_found" });
  if (!seen.reply) {
    return JSON.stringify({ result: "denied", reason: run.message ?? run.errorType ?? "blocked" });
  }
  return JSON.stringify(seen.reply);
}
