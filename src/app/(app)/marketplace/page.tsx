import { redirect } from "next/navigation";

/** The Marketplace is now the "Discover" tab of Tuning. Filters in the old link carry over. */
export default async function MarketplaceRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const next = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v) as [string, string][],
  );
  next.set("tab", "discover");
  redirect(`/tuning?${next}`);
}
