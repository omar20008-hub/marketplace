import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { hit } from "@/lib/rate-limit";
import { Button, Card, FootNote, PageTitle } from "@/components/ds";
import { normalizeSiteUrl, requestSiteLoginLink } from "@/server/site-logins";

export const metadata = { title: "Add a website login · Builder" };

/**
 * Opens a one-time form for the login of any website: /logins/new?site=<address>.
 * It does not depend on the assistant. The person must be signed in, and the
 * page goes straight to the secure form for that site.
 */
export default async function NewLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ site?: string }>;
}) {
  const { site } = await searchParams;
  const user = await requireUser();

  if (!site?.trim()) return <SiteForm value="" />;

  const raw = site.trim();
  const ref = normalizeSiteUrl(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if ("error" in ref) return <SiteForm value={raw} error={ref.error} />;

  const limit = hit(`vault-link:${user.id}`, { limit: 10, windowMs: 60 * 60_000 });
  if (!limit.ok) {
    return <SiteForm value={raw} error="Too many requests. Try again later." />;
  }

  const { token } = await requestSiteLoginLink({ userId: user.id, siteUrl: ref.siteUrl });
  redirect(`/logins/add/${token}`);
}

function SiteForm({ value, error }: { value: string; error?: string }) {
  return (
    <div className="px-5 py-5 lg:px-7">
      <PageTitle title="Add a website login" />

      <Card className="mt-5 flex max-w-lg flex-col gap-4 p-4">
        <p className="text-[13px] text-ink-2">
          Enter the address of the website. The login is stored encrypted and used only for sign-ins
          you ask for.
        </p>

        {error ? (
          <p role="alert" className="text-[13px] text-danger-ink">
            {error}
          </p>
        ) : null}

        <form method="get" action="/logins/new" className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-[13px]">
            Website address
            <input
              name="site"
              required
              defaultValue={value}
              placeholder="https://www.linkedin.com/login"
              maxLength={2000}
              className="rounded-md border border-line bg-canvas px-3 py-2 text-sm"
            />
          </label>
          <div>
            <Button type="submit" size="sm">
              Continue
            </Button>
          </div>
        </form>
        <FootNote>You can remove any saved login from Saved logins at any time.</FootNote>
      </Card>
    </div>
  );
}
