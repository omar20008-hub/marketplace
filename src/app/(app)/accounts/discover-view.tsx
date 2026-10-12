import Link from "next/link";
import clsx from "clsx";
import { Plus } from "lucide-react";
import { Badge, Card, Meta, SectionLabel } from "@/components/ds";
import { CATALOG, type CatalogEntry } from "@/lib/connectors/catalog";

/** The two views of the Connectors tab. "Yours" is the default and has no query value. */
export function ConnectorsTabs({ active }: { active: "yours" | "discover" }) {
  const tabs = [
    { key: "yours", label: "Yours", href: "/accounts" },
    { key: "discover", label: "Discover", href: "/accounts?tab=discover" },
  ] as const;
  return (
    <nav
      aria-label="Connectors views"
      className="inline-flex rounded-full border border-line bg-fill p-0.5"
    >
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={tab.key === active ? "page" : undefined}
          className={clsx(
            "rounded-full px-3.5 py-1 text-[13px]",
            tab.key === active ? "bg-canvas font-medium shadow-sm" : "text-ink-2 hover:text-ink",
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Every tool the platform lists. Connectable ones link into the Connect panel on
 * Yours; the rest are listed as coming soon. Search is a plain GET form, so it
 * works without script and survives a reload.
 */
export function DiscoverView({
  q,
  available,
  connectedTypes,
}: {
  q: string;
  /** The credentialTypes the platform can connect today. */
  available: Set<string>;
  /** The credentialTypes this person already has a live connection for. */
  connectedTypes: Set<string>;
}) {
  const needle = q.trim().toLowerCase();
  const entries = CATALOG.filter(
    (entry) =>
      !needle ||
      entry.name.toLowerCase().includes(needle) ||
      entry.by.toLowerCase().includes(needle) ||
      entry.description.toLowerCase().includes(needle),
  );

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-center gap-3">
        <SectionLabel>All connectors</SectionLabel>
        <Meta>{entries.length}</Meta>
        <form action="/accounts" method="get" className="ml-auto w-full sm:w-72">
          <input type="hidden" name="tab" value="discover" />
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Search connectors"
            aria-label="Search connectors"
            className="h-9 w-full rounded-row border border-line bg-canvas px-3 text-[13px] outline-none focus:border-ink-3"
          />
        </form>
      </div>

      {entries.length === 0 ? (
        <p className="mt-6 text-[13px] text-ink-3">No connector matches “{q}”.</p>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
          {entries.map((entry) => (
            <DiscoverCard
              key={entry.name}
              entry={entry}
              state={stateOf(entry, available, connectedTypes)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type CardState = "connected" | "connect" | "soon";

function stateOf(
  entry: CatalogEntry,
  available: Set<string>,
  connectedTypes: Set<string>,
): CardState {
  if (entry.credentialType && connectedTypes.has(entry.credentialType)) return "connected";
  if (entry.href) return "connect";
  if (entry.credentialType && available.has(entry.credentialType)) return "connect";
  return "soon";
}

function DiscoverCard({ entry, state }: { entry: CatalogEntry; state: CardState }) {
  const href =
    entry.href ??
    (entry.credentialType ? `/accounts?connect=${entry.credentialType}` : undefined);

  return (
    <Card className="flex items-start gap-3 p-4">
      <span className="flex size-10 flex-none items-center justify-center rounded-row bg-fill text-xs font-medium text-ink-2">
        {entry.initials}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{entry.name}</div>
        <div className="mt-0.5 text-[13px] text-ink-2">{entry.description}</div>
        <div className="mt-1 text-xs text-ink-3">by {entry.by}</div>
      </div>
      {state === "connected" ? (
        <Badge tone="ready">Connected</Badge>
      ) : state === "connect" && href ? (
        <Link
          href={href}
          aria-label={`Connect ${entry.name}`}
          title={`Connect ${entry.name}`}
          className="flex size-8 flex-none items-center justify-center rounded-row border border-line hover:bg-fill"
        >
          <Plus size={16} strokeWidth={2} />
        </Link>
      ) : (
        <Badge>Soon</Badge>
      )}
    </Card>
  );
}
