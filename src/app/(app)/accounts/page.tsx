import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";

/**
 * Connectors is now the "My Connectors" tab of Tuning, and its Discover list sits in
 * Tuning's Discover tab. Old links, and the return from a sign-in, land here with their query.
 */
export default async function AccountsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireUser();
  const { tab, ...rest } = await searchParams;
  const next = new URLSearchParams(
    Object.entries(rest).filter(([, v]) => v) as [string, string][],
  );
  if (tab === "discover") {
    next.set("tab", "discover");
    next.set("kind", "connector");
  } else {
    next.set("tab", "connectors");
  }
  redirect(`/tuning?${next}`);
}
