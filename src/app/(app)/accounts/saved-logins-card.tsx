import Link from "next/link";
import { Button, Card } from "@/components/ds";
import { listSiteLogins } from "@/server/site-logins";
import { removeLoginAction } from "@/server/site-login-actions";

/**
 * The websites the personal assistant can sign in to for you. Passwords are
 * stored encrypted and never shown; any site can be removed here.
 */
export async function SavedLoginsCard({ userId }: { userId: string }) {
  const logins = await listSiteLogins(userId);

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Saved logins</h2>
        <Link href="/logins/new" className="text-[13px] text-link hover:underline">
          Add a login
        </Link>
      </div>
      <p className="mt-1 text-xs text-ink-3">
        Websites your assistant can sign in to for you. Passwords are stored encrypted and are never
        shown.
      </p>

      {logins.length === 0 ? (
        <p className="mt-3 text-[13px] text-ink-3">
          No saved logins yet. When a site asks for a login, your assistant will send you a secure
          link to add it here.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {logins.map((login) => (
            <li key={login.id} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{login.host}</div>
                <div className="truncate text-xs text-ink-3">
                  {login.username}
                  {login.lastUsedAt
                    ? ` · last used ${login.lastUsedAt.toLocaleDateString()}`
                    : " · not used yet"}
                </div>
              </div>
              <form action={removeLoginAction}>
                <input type="hidden" name="id" value={login.id} />
                <Button tone="danger" size="sm" type="submit">
                  Remove
                </Button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
