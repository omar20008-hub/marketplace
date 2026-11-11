import { currentUser } from "@/lib/auth";
import { PageTitle } from "@/components/ds";
import { AgentsView } from "./agents-view";
import { DiscoverView, type Search } from "./discover-view";
import { TuningTabs } from "./tuning-tabs";

export const metadata = { title: "Tuning · Builder" };

type Params = Search & { filter?: string };

/**
 * Where agents are found and managed: Discover lists everything that can be added,
 * My agents lists what this person already has. A guest may browse Discover, so
 * they land there; My agents needs an account.
 */
export default async function TuningPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const user = await currentUser();
  const view = !user || params.tab === "discover" ? "discover" : "agents";

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 pt-5 lg:px-7">
        <PageTitle title="Tuning" />
        <TuningTabs active={view} />
      </div>
      {view === "agents" ? <AgentsView filter={params.filter} /> : <DiscoverView params={params} />}
    </div>
  );
}
