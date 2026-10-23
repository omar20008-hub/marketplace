import { BRAND_ICONS } from "@/lib/connectors/brand-icons";

/**
 * A mark whose every channel is dark (Notion's black, ServiceNow's near-black)
 * would vanish on a dark tile, so it takes the text colour instead.
 */
function isNearBlack(hex: string): boolean {
  const channels = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return Math.max(...channels) < 0x40;
}

/**
 * A tool's logo in its tile, or its initials where the catalog has no logo for it.
 */
export function BrandMark({ slug, initials }: { slug?: string; initials: string }) {
  const icon = slug ? BRAND_ICONS[slug] : undefined;
  return (
    <span className="flex size-10 flex-none items-center justify-center rounded-row bg-fill text-xs font-medium text-ink-2">
      {icon ? (
        <svg
          viewBox="0 0 24 24"
          width={20}
          height={20}
          aria-hidden="true"
          style={{ fill: isNearBlack(icon.hex) ? "currentColor" : `#${icon.hex}` }}
        >
          <path d={icon.path} />
        </svg>
      ) : (
        initials
      )}
    </span>
  );
}
