/**
 * How a product is invoked once installed, set by Upload & Provision from the
 * trigger nodes it finds. on_demand is the only kind the chat interface ever
 * calls — scheduled and event products run inside n8n on their own, and the
 * marketplace/workspace UI only needs to say so, never to drive them.
 *
 * The reply is comma-separated rather than a single value: a workflow can
 * combine an Execute Workflow Trigger with an autonomous one (e.g. a chat
 * agent that also reacts to an incoming event), so "on_demand,event" is a
 * real, single product — not two products or an error.
 */

const LABELS: Record<string, string> = {
  on_demand: "يُستدعى عند الطلب من المحادثة",
  scheduled: "يعمل بجدولة تلقائية",
  event: "يعمل تلقائياً عند حدث معيّن",
};

function modesOf(raw: string): string[] {
  const modes = raw
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m in LABELS);
  return modes.length > 0 ? modes : ["on_demand"];
}

export function invocationModeLabel(raw: string): string {
  return modesOf(raw)
    .map((mode) => LABELS[mode])
    .join(" + ");
}

/** Whether the chat interface (and so the workspace's Run button) can call this product. */
export function isOnDemand(raw: string): boolean {
  return modesOf(raw).includes("on_demand");
}

/** Whether an n8n-native trigger runs this product on its own, without anyone clicking Run. */
export function runsAutomatically(raw: string): boolean {
  const modes = modesOf(raw);
  return modes.includes("scheduled") || modes.includes("event");
}

export function isScheduled(raw: string): boolean {
  return modesOf(raw).includes("scheduled");
}
