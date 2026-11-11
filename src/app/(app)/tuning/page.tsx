import { currentUser } from "@/lib/auth";
import { PageTitle } from "@/components/ds";
import { AgentsView } from "./agents-view";
import { ConnectorsDiscover, ConnectorsView } from "./connectors-view";
import { DiscoverView, type Search } from "./discover-view";
import { DiscoverKindFilter, TuningTabs, type TuningTab } from "./tuning-tabs";

export const metadata = { title: "Tuning · Builder" };

type Params = Search & {
  filter?: string;
  kind?: string;
  connect?: string;
  connected?: string;
  connect_error?: string;
  login_saved?: string;
};

/**
 * Where agents and the accounts they use are found and managed. My Agents and My
 * Connectors are what this person already has; Discover lists everything that can be
 * added, agents or connectors. A guest may browse the agents in Discover, so they land
 * there; the other two need an account.
 */
export default async function TuningPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const user = await currentUser();
  const tab: TuningTab = !user
    ? "discover"
    : params.tab === "discover" || params.tab === "connectors"
      ? params.tab
      : "agents";
  const kind = user && params.kind === "connector" ? "connector" : "agent";

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 pt-5 lg:px-7">
        <PageTitle title="Tuning" />
        <TuningTabs active={tab} />
      </div>
      {tab === "agents" ? <AgentsView filter={params.filter} /> : null}
      {tab === "connectors" && user ? (
        <ConnectorsView
          user={user}
          connect={params.connect}
          connected={params.connected}
          connectError={params.connect_error}
          loginSaved={params.login_saved}
        />
      ) : null}
      {tab === "discover" ? (
        <>
          {user ? <DiscoverKindFilter active={kind} /> : null}
          {kind === "connector" ? (
            <div className="px-5 pb-10 lg:px-7">
              <ConnectorsDiscover user={user} q={params.q ?? ""} />
            </div>
          ) : (
            <DiscoverView params={params} />
          )}
        </>
      ) : null}
    </div>
  );
}
