import { BRAND_ICONS } from "@/lib/connectors/brand-icons";

/**
 * A tool's logo in its tile, or its initials where the catalog has no logo for it.
 * Notion's mark is black, which disappears on a dark tile, so it takes the text colour.
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
          style={{ fill: icon.hex === "000000" ? "currentColor" : `#${icon.hex}` }}
        >
          <path d={icon.path} />
        </svg>
      ) : (
        initials
      )}
    </span>
  );
}
