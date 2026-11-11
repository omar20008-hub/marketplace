import Link from "next/link";
import clsx from "clsx";

export type TuningTab = "agents" | "connectors" | "discover";

/** The three views of Tuning. "My Agents" is the default and has no query value. */
export function TuningTabs({ active }: { active: TuningTab }) {
  const tabs = [
    { key: "agents", label: "My Agents", href: "/tuning" },
    { key: "connectors", label: "My Connectors", href: "/tuning?tab=connectors" },
    { key: "discover", label: "Discover", href: "/tuning?tab=discover" },
  ] as const;
  return (
    <nav
      aria-label="Tuning views"
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

/** Discover lists agents and connectors; this picks which. Agents is the default. */
export function DiscoverKindFilter({ active }: { active: "agent" | "connector" }) {
  const kinds = [
    { key: "agent", label: "Agents", href: "/tuning?tab=discover" },
    { key: "connector", label: "Connectors", href: "/tuning?tab=discover&kind=connector" },
  ] as const;
  return (
    <nav aria-label="Discover filter" className="flex gap-1.5 px-5 pt-4 text-[13px] lg:px-7">
      {kinds.map((kind) => (
        <Link
          key={kind.key}
          href={kind.href}
          aria-current={kind.key === active ? "page" : undefined}
          className={clsx(
            "rounded-full px-3 py-1",
            kind.key === active
              ? "bg-ink text-white"
              : "border border-line text-ink-2 hover:bg-fill",
          )}
        >
          {kind.label}
        </Link>
      ))}
    </nav>
  );
}
