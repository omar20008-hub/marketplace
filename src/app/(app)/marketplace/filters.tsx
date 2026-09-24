"use client";

import clsx from "clsx";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * The filter rail. Everything writes to the query string so a filtered view is
 * a link you can send someone.
 */
export function MarketplaceFilters({
  typeCounts,
  categoryCounts,
  integrations,
}: {
  typeCounts: { AGENT: number; WORKFLOW: number };
  categoryCounts: Record<string, number>;
  integrations: { value: string; label: string }[];
}) {
  const router = useRouter();
  const params = useSearchParams();

  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value === null || next.get(key) === value) next.delete(key);
    else next.set(key, value);
    router.push(`/marketplace?${next}`);
  };

  const readyOnly = params.get("ready") !== "0";

  return (
    <aside className="flex w-full flex-none flex-col gap-5 px-5 pt-3 text-[13px] lg:w-[220px] lg:gap-[22px]">
      <div className="rounded-[14px] border border-selected p-3">
        <div className="flex items-center justify-between">
          <span className="font-medium">Ready to run now</span>
          <button
            type="button"
            role="switch"
            aria-checked={readyOnly}
            aria-label="Ready to run now"
            onClick={() => set("ready", readyOnly ? "0" : null)}
            className={clsx(
              "relative h-5 w-[34px] flex-none rounded-full transition-colors",
              readyOnly ? "bg-ink" : "bg-line",
            )}
          >
            <span
              className={clsx(
                "absolute top-0.5 size-4 rounded-full bg-white transition-all",
                readyOnly ? "right-0.5" : "left-0.5",
              )}
            />
          </button>
        </div>
        <p className="mt-1.5 text-xs leading-snug text-ink-3">
          Only products that work with the accounts and plan you already have.
        </p>
      </div>

      <Group label="Type">
        <Row
          label="Agents"
          count={typeCounts.AGENT}
          active={params.get("type") === "AGENT"}
          onClick={() => set("type", "AGENT")}
        />
        <Row
          label="Workflows"
          count={typeCounts.WORKFLOW}
          active={params.get("type") === "WORKFLOW"}
          onClick={() => set("type", "WORKFLOW")}
        />
      </Group>

      <Group label="Category">
        {Object.entries(categoryCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([category, count]) => (
            <Row
              key={category}
              label={category}
              count={count}
              active={params.get("category") === category}
              onClick={() => set("category", category)}
            />
          ))}
      </Group>

      {integrations.length > 0 ? (
        <Group label="Integrations required">
          <div className="flex flex-wrap gap-1.5">
            {integrations.map((integration) => {
              const active = params.get("integration") === integration.value;
              return (
                <button
                  key={integration.value}
                  type="button"
                  onClick={() => set("integration", integration.value)}
                  className={clsx(
                    "rounded-full px-2.5 py-1",
                    active
                      ? "bg-ink text-white"
                      : "border border-line hover:bg-fill",
                  )}
                >
                  {integration.label}
                </button>
              );
            })}
          </div>
        </Group>
      ) : null}

      <Group label="Trust">
        <span className="text-ink-2">Platform approved</span>
        <span className="text-ink-2">Creator verified</span>
        <span className="text-ink-2">Healthy</span>
      </Group>
    </aside>
  );
}

function Group({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-ink-3">{label}</span>
      {children}
    </div>
  );
}

function Row({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "flex justify-between text-left",
        active ? "font-medium text-ink" : "text-ink",
      )}
    >
      <span>{label}</span>
      <span className={active ? "text-ink" : "text-ink-3"}>{count}</span>
    </button>
  );
}
