import { requireUser } from "@/lib/auth";
import { Button, Card, FootNote, PageTitle } from "@/components/ds";
import { readSiteLoginLink } from "@/server/site-logins";
import { saveLoginAction } from "@/server/site-login-actions";

export const metadata = { title: "Add a login · Builder" };

const ERRORS: Record<string, string> = {
  input: "Enter a username and a password.",
  invalid: "This link is not valid.",
  expired: "This link has expired. Ask your assistant for a new one.",
  used: "This link was already used.",
  not_yours: "This link belongs to another account. Sign in with the account that asked for it.",
};

/**
 * The page the secure link opens. The password is typed here, on the platform,
 * and goes straight to encrypted storage. It is never sent to a chat.
 */
export default async function AddLoginPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;
  const user = await requireUser();
  const link = await readSiteLoginLink(user.id, token);

  return (
    <div className="px-5 py-5 lg:px-7">
      <PageTitle title="Add a login" />

      <Card className="mt-5 flex max-w-lg flex-col gap-4 p-4">
        {!link.ok ? (
          <p role="alert" className="text-[13px] text-danger-ink">
            {ERRORS[link.reason] ?? ERRORS.invalid}
          </p>
        ) : (
          <>
            <p className="text-[13px] text-ink-2">
              Your assistant needs a login for <span className="font-medium">{link.host}</span>.
              It is stored encrypted, and used only for sign-ins you ask for.
            </p>

            {error ? (
              <p role="alert" className="text-[13px] text-danger-ink">
                {ERRORS[error] ?? ERRORS.input}
              </p>
            ) : null}

            <form action={saveLoginAction} className="flex flex-col gap-3">
              <input type="hidden" name="token" value={token} />
              <label className="flex flex-col gap-1 text-[13px]">
                Username or email
                <input
                  name="username"
                  required
                  maxLength={200}
                  autoComplete="off"
                  className="rounded-md border border-line bg-canvas px-3 py-2 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-[13px]">
                Password
                <input
                  name="password"
                  type="password"
                  required
                  maxLength={500}
                  autoComplete="new-password"
                  className="rounded-md border border-line bg-canvas px-3 py-2 text-sm"
                />
              </label>
              <div>
                <Button type="submit" size="sm">
                  Save login
                </Button>
              </div>
            </form>
            <FootNote>You can remove this login from Saved logins at any time.</FootNote>
          </>
        )}
      </Card>
    </div>
  );
}
