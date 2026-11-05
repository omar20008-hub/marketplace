import { Card, FootNote, SectionLabel } from "@/components/ds";
import { prisma } from "@/lib/db";
import { formatDate } from "@/lib/readiness";
import { AUTO_INSTALL_STATUS_KEY, type AutoInstallStatus } from "@/server/auto-install";
import { N8N_STATUS_KEY, type N8nApiStatus } from "@/server/n8n-canary";

/**
 * The state of the connection to n8n as the hourly check last saw it. When it is not
 * "ok", new people do not get their products until it is, and this says so.
 */
export async function HealthAdmin() {
  const [row, installRow] = await Promise.all([
    prisma.platformStatus.findUnique({ where: { key: N8N_STATUS_KEY } }),
    prisma.platformStatus.findUnique({ where: { key: AUTO_INSTALL_STATUS_KEY } }),
  ]);
  const status = row?.value as N8nApiStatus | undefined;
  const installs = installRow?.value as AutoInstallStatus | undefined;

  const text = {
    ok: "Answering. Installs run as normal.",
    rejected: "Refusing the platform's key. Installs are paused. Create a new key in n8n and save it on the n8n account credential.",
    unreachable: "Not reachable right now. Installs are paused until it answers.",
    unconfigured:
      "No n8n REST address or key is set on the platform, so the key cannot be checked here. Installs still run through the install workflow; the card below shows how they are doing.",
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
        <FootNote>No check has run yet. It runs hourly from the scheduler on the server.</FootNote>
      )}

      <SectionLabel>Latest automatic installs</SectionLabel>
      {installs ? (
        <Card className="flex flex-col gap-2 p-4">
          <div className="text-sm font-medium">
            {installs.installed} installed · {installs.refused} refused
          </div>
          <FootNote>Last attempt {formatDate(new Date(installs.at))}</FootNote>
          {installs.lastError ? <FootNote>Latest refusal: {installs.lastError}</FootNote> : null}
        </Card>
      ) : (
        <FootNote>No automatic install has run yet.</FootNote>
      )}
    </div>
  );
}
