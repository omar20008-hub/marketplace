/**
 * How a product is invoked once installed, set by Upload & Provision from the
 * trigger nodes it finds. on_demand is the only kind the chat interface ever
 * calls — scheduled and event products run inside n8n on their own, and the
 * marketplace/workspace UI only needs to say so, never to drive them.
 */
export function invocationModeLabel(mode: string): string {
  switch (mode) {
    case "scheduled":
      return "يعمل بجدولة تلقائية";
    case "event":
      return "يعمل تلقائياً عند حدث معيّن";
    default:
      return "يُستدعى عند الطلب من المحادثة";
  }
}
