import { Card, FootNote, SectionLabel } from "@/components/ds";
import { prisma } from "@/lib/db";
import { formatDate } from "@/lib/readiness";
import { N8N_STATUS_KEY, type N8nApiStatus } from "@/server/n8n-canary";

/**
 * The state of the connection to n8n as the hourly check last saw it. When it is not
 * "ok", new people do not get their products until it is, and this says so.
 */
export async function HealthAdmin() {
  const row = await prisma.platformStatus.findUnique({ where: { key: N8N_STATUS_KEY } });
  const status = row?.value as N8nApiStatus | undefined;

  const text = {
    ok: "Answering. Installs run as normal.",
    rejected: "Refusing the platform's key. Installs are paused. Create a new key in n8n and save it on the n8n account credential.",
    unreachable: "Not reachable right now. Installs are paused until it answers.",
  } as const;

  return (
    <div className="mt-5 flex flex-col gap-4">
      <SectionLabel>n8n connection</SectionLabel>
      {status ? (
        <Card className="flex flex-col gap-2 p-4">
          <div className="text-sm font-medium">{status.state}</div>
          <FootNote>{text[status.state]}</FootNote>
          <FootNote>
            Since {formatDate(new Date(status.since))} · last checked {formatDate(new Date(status.checkedAt))}
            {status.state === "ok" ? ` · ${status.caughtUp} missed install(s) given in the last check` : ""}
          </FootNote>
        </Card>
      ) : (
        <FootNote>No check has run yet. It runs hourly once the scheduled call is set up.</FootNote>
      )}
    </div>
  );
}
