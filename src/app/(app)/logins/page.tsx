import { requireUser } from "@/lib/auth";
import { Button, Card, FootNote, PageTitle } from "@/components/ds";
import { listSiteLogins } from "@/server/site-logins";
import { removeLoginAction } from "@/server/site-login-actions";

export const metadata = { title: "Saved logins · Builder" };

/**
 * The websites the personal assistant can sign in to for you. Passwords are
 * stored encrypted and are never shown here; you can remove any of them.
 */
export default async function LoginsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>;
}) {
  const { saved } = await searchParams;
  const user = await requireUser();
  const logins = await listSiteLogins(user.id);

  return (
    <div className="px-5 py-5 lg:px-7">
      <PageTitle title="Saved logins" meta={`· ${logins.length} saved`} />

      {saved ? (
        <p role="status" className="mt-3 text-[13px] text-ready-ink">
          Login saved.
        </p>
      ) : null}

      <p className="mt-3 max-w-2xl text-[13px] text-ink-2">
        These are the websites where your assistant can sign in for you. Passwords are stored
        encrypted and are never shown. Remove a site here at any time.
      </p>

      <div className="mt-5 flex flex-col gap-2">
        {logins.length === 0 ? (
          <Card className="p-4 text-sm text-ink-3">
            No saved logins yet. When a site asks for a login, your assistant will send you a
            secure link to add it here.
          </Card>
        ) : (
          logins.map((login) => (
            <Card key={login.id} className="flex flex-wrap items-center gap-3 p-3.5">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{login.host}</div>
                <div className="mt-0.5 text-xs text-ink-3">
                  {login.username} · saved {login.createdAt.toLocaleDateString()}
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
            </Card>
          ))
        )}
      </div>

      <div className="mt-4">
        <FootNote>Removing a login does not sign you out of the website itself.</FootNote>
      </div>
    </div>
  );
}
