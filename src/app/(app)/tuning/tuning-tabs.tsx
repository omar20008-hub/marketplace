import Link from "next/link";
import clsx from "clsx";

/** The two views of Tuning. "My agents" is the default and has no query value. */
export function TuningTabs({ active }: { active: "agents" | "discover" }) {
  const tabs = [
    { key: "agents", label: "My agents", href: "/tuning" },
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
