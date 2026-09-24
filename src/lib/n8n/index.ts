import "server-only";
import { env } from "../env";
import type { N8nDriver } from "./driver";
import { liveDriver } from "./live";
import { mockDriver } from "./mock";

/**
 * Pick once, at module load. Switching drivers is a restart, not a per-request
 * decision, so nothing downstream has to care which one it is talking to.
 */
export const n8n: N8nDriver =
  env.n8n.driver === "live" ? liveDriver : mockDriver;

export * from "./contracts";
export type { N8nDriver } from "./driver";
