import { Button, Card, FootNote, Input, SectionLabel } from "@/components/ds";
import { credentialLabel, PLATFORM_HELD_CREDENTIALS } from "@/lib/credentials";
import { platformKeyStatus } from "@/lib/platform-secrets";
import { formatDate } from "@/lib/readiness";
import { setPlatformKey } from "@/server/admin-actions";

/**
 * The keys the platform supplies to every product (see PLATFORM_HELD_CREDENTIALS).
 * A key is written here and never shown again: the screen says where it comes from,
 * not what it is.
 */
export async function PlatformKeys({
  saved,
  error,
  errorType,
}: {
  saved?: string;
  error?: string;
  errorType?: string;
}) {
  const types = [...PLATFORM_HELD_CREDENTIALS];
  const statuses = await Promise.all(types.map((type) => platformKeyStatus(type)));

  const sourceText = {
    stored: "Saved here",
    environment: "From the server environment (GEMINI_API_KEY)",
    missing: "Not set",
  } as const;

  return (
    <div className="mt-5 flex flex-col gap-4">
      <SectionLabel>Platform keys</SectionLabel>
      <FootNote>
        Products use these keys without the person connecting anything. The value is
        encrypted when saved and is never shown again.
      </FootNote>

      {types.map((type, index) => {
        const status = statuses[index];
        const isSaved = saved === type;
        const isInvalid = error === "invalid" && errorType === type;
        return (
          <Card key={type} className="flex flex-col gap-3 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="text-sm font-medium">{credentialLabel(type)}</div>
              <div className="text-xs text-ink-3">
                {sourceText[status.source]}
                {status.updatedAt ? ` · saved ${formatDate(status.updatedAt)}` : ""}
              </div>
            </div>

            <form action={setPlatformKey} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="credentialType" value={type} />
              <Input
                name="apiKey"
                type="password"
                autoComplete="off"
                placeholder={status.source === "stored" ? "Paste a new key to replace it" : "Paste the key"}
                className="min-w-0 flex-1"
                required
              />
              <Button type="submit" size="sm">
                Save key
              </Button>
            </form>

            {isSaved ? <p className="text-[13px] text-ink-2">Saved.</p> : null}
            {isInvalid ? (
              <p className="text-[13px] text-danger-ink">
                That does not look like a key. Paste the whole key, with no spaces.
              </p>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}
