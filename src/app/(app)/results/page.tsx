import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";

/** Results is now the "Results" tab of Admin. Old links keep working: ?view= becomes ?section=. */
export default async function ResultsRedirect({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; run?: string; status?: string }>;
}) {
  // Still admin-only: anyone else is turned away exactly as before.
  await requireRole("ADMIN");
  const { view, run, status } = await searchParams;
  const next = new URLSearchParams({ view: "results" });
  if (view) next.set("section", view);
  if (run) next.set("run", run);
  if (status) next.set("status", status);
  redirect(`/admin?${next}`);
}
