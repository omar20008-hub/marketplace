import {
  Bot,
  Braces,
  FileText,
  Megaphone,
  Receipt,
  Scale,
  TrendingUp,
  UserRound,
  Workflow,
} from "lucide-react";
import type { ReactNode } from "react";

/**
 * The small coloured square in front of a product. The design uses a different
 * tint per category, which is the one place colour is decorative rather than a
 * status signal — so the tints are kept well away from the green/amber/red set.
 */
const CATEGORY: Record<string, { tint: string; ink: string; icon: ReactNode }> = {
  Sales: { tint: "#eaf2ff", ink: "#1f5fd1", icon: <TrendingUp /> },
  Marketing: { tint: "#ffede6", ink: "#c2441c", icon: <Megaphone /> },
  Finance: { tint: "#e9f4ef", ink: "#1a6b4a", icon: <Receipt /> },
  Operations: { tint: "#f1ecff", ink: "#6a3fd6", icon: <Bot /> },
  Legal: { tint: "#f3f0e8", ink: "#7a6320", icon: <Scale /> },
  HR: { tint: "#fdeef4", ink: "#9c2b62", icon: <UserRound /> },
  Content: { tint: "#eaf5f6", ink: "#1a6672", icon: <FileText /> },
};

const FALLBACK = { tint: "#f4f4f4", ink: "#5d5d5d", icon: <Braces /> };

export function ProductGlyph({
  category,
  kind,
  size = 32,
}: {
  category: string;
  kind?: "AGENT" | "WORKFLOW";
  size?: number;
}) {
  const style = CATEGORY[category] ?? FALLBACK;
  const icon = kind === "AGENT" ? <Bot /> : kind === "WORKFLOW" ? <Workflow /> : style.icon;
  const glyphSize = Math.round(size * 0.55);

  return (
    <span
      className="flex flex-none items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.28),
        background: style.tint,
        color: style.ink,
      }}
    >
      <span
        className="[&>svg]:size-[var(--glyph)] [&>svg]:stroke-[1.8]"
        style={{ ["--glyph" as string]: `${glyphSize}px` }}
      >
        {icon}
      </span>
    </span>
  );
}
