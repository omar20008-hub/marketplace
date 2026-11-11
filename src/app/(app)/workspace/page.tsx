import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";

/** My workspace is now the "My agents" tab of Tuning. Old links, and the return from a sign-in, land here. */
export default async function WorkspaceRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  // Still a private address: a guest is sent to sign in, not to the public Discover tab.
  await requireUser();
  const { tab, ...rest } = await searchParams;
  const next = new URLSearchParams(
    Object.entries(rest).filter(([, v]) => v) as [string, string][],
  );
  if (tab === "attention" || tab === "favourites") next.set("filter", tab);
  const query = next.toString();
  redirect(query ? `/tuning?${query}` : "/tuning");
}
