import clsx from "clsx";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

/**
 * Builder design system v1, transcribed from frame 1a of the design canvas.
 *
 *   Black is the only action colour.
 *   Blue marks upgrades and links.
 *   Green, amber and red are reserved for readiness and run status.
 *
 * Buttons are always pills. Radii are 10 for a row, 16 for a card, 24 for a
 * modal, 28 for the composer. The tokens themselves live in globals.css.
 */

// ------------------------------------------------------------------ button

type ButtonTone = "primary" | "secondary" | "quiet" | "upgrade" | "danger";
type ButtonSize = "sm" | "md";

const buttonTone: Record<ButtonTone, string> = {
  primary: "bg-ink text-white hover:bg-black",
  secondary: "border border-line bg-canvas text-ink hover:bg-fill",
  // "Activate — 1 left": present but not yet available.
  quiet: "bg-selected text-ink-3 cursor-not-allowed",
  upgrade: "bg-link-tint text-link-ink hover:brightness-97",
  danger: "border border-danger-line text-danger-ink hover:bg-danger-tint",
};

const buttonSize: Record<ButtonSize, string> = {
  sm: "h-8 px-3.5 text-[13px]",
  md: "h-10 px-[18px] text-sm",
};

export function buttonClass(
  tone: ButtonTone = "primary",
  size: ButtonSize = "md",
  className?: string,
) {
  return clsx(
    "inline-flex items-center justify-center gap-1.5 rounded-full font-medium",
    "transition-colors disabled:opacity-60 disabled:cursor-not-allowed",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link",
    buttonTone[tone],
    buttonSize[size],
    className,
  );
}

export function Button({
  tone = "primary",
  size = "md",
  className,
  ...rest
}: ComponentProps<"button"> & { tone?: ButtonTone; size?: ButtonSize }) {
  return <button className={buttonClass(tone, size, className)} {...rest} />;
}

export function ButtonLink({
  tone = "primary",
  size = "md",
  className,
  ...rest
}: ComponentProps<typeof Link> & { tone?: ButtonTone; size?: ButtonSize }) {
  return <Link className={buttonClass(tone, size, className)} {...rest} />;
}

/**
 * The same pill, as a plain anchor.
 *
 * For a URL that answers with a file rather than a route: `next/link`
 * prefetches on hover, so a Link to `/api/artifacts/…` would fetch the whole
 * file just because the pointer passed over it, throw the bytes away — they are
 * not an RSC payload — and fetch them again on the click.
 */
export function ButtonAnchor({
  tone = "primary",
  size = "md",
  className,
  ...rest
}: ComponentProps<"a"> & { tone?: ButtonTone; size?: ButtonSize }) {
  return <a className={buttonClass(tone, size, className)} {...rest} />;
}

// ------------------------------------------------------------------ badges

export type BadgeTone =
  | "ready"
  | "partial"
  | "plan"
  | "blocked"
  | "restricted"
  | "platform"
  | "neutral";

const badgeTone: Record<BadgeTone, { wrap: string; dot?: string }> = {
  ready: { wrap: "bg-ready-tint text-ready-ink", dot: "bg-ready" },
  partial: { wrap: "bg-warn-tint text-warn-ink", dot: "bg-warn" },
  plan: { wrap: "bg-link-tint text-link-ink" },
  blocked: { wrap: "bg-danger-tint text-danger-ink", dot: "bg-danger" },
  restricted: { wrap: "bg-danger-tint text-danger-ink" },
  platform: { wrap: "bg-fill text-ink-2" },
  neutral: { wrap: "bg-fill text-ink-2" },
};

export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  const style = badgeTone[tone];
  return (
    <span
      className={clsx(
        "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5",
        "text-xs font-medium whitespace-nowrap",
        style.wrap,
        className,
      )}
    >
      {style.dot ? (
        <span className={clsx("size-1.5 rounded-full", style.dot)} />
      ) : null}
      {children}
    </span>
  );
}

// ------------------------------------------------------------------ layout

export function Card({
  className,
  children,
  tone = "plain",
}: {
  className?: string;
  children: ReactNode;
  tone?: "plain" | "danger";
}) {
  return (
    <div
      className={clsx(
        "rounded-card border",
        tone === "danger"
          ? "border-danger-line bg-danger-wash"
          : "border-selected bg-canvas",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SectionLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx("text-[13px] font-semibold", className)}>
      {children}
    </div>
  );
}

export function Meta({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={clsx("text-xs text-ink-3", className)}>{children}</span>
  );
}

export function Mono({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={clsx("font-mono text-xs text-ink-2", className)}>
      {children}
    </span>
  );
}

export function PageTitle({
  title,
  meta,
  actions,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <h1 className="text-base font-medium">{title}</h1>
      {meta ? <span className="text-xs text-ink-3">{meta}</span> : null}
      {actions ? <div className="ml-auto flex gap-2">{actions}</div> : null}
    </div>
  );
}

export function Avatar({
  initials,
  tint = "#dfe7f5",
  ink = "#1f4f9a",
  size = 32,
}: {
  initials: string;
  tint?: string;
  ink?: string;
  size?: number;
}) {
  return (
    <span
      className="flex flex-none items-center justify-center rounded-full text-xs font-semibold"
      style={{ width: size, height: size, background: tint, color: ink }}
    >
      {initials}
    </span>
  );
}

export function Divider({ className }: { className?: string }) {
  return <div className={clsx("h-px bg-selected", className)} />;
}

// ------------------------------------------------------------------- forms

export function Field({
  label,
  hint,
  children,
  required,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium">
        {label}
        {required ? <span className="ml-1 text-ink-3">· required</span> : null}
      </span>
      {children}
      {hint ? <span className="text-xs text-ink-3">{hint}</span> : null}
    </label>
  );
}

const controlClass =
  "w-full rounded-row border border-line bg-canvas px-3 py-2 text-sm " +
  "placeholder:text-ink-3 focus:border-ink focus:outline-none";

export function Input({ className, ...rest }: ComponentProps<"input">) {
  return <input className={clsx(controlClass, "h-10", className)} {...rest} />;
}

export function Textarea({ className, ...rest }: ComponentProps<"textarea">) {
  return <textarea className={clsx(controlClass, className)} {...rest} />;
}

export function Select({ className, ...rest }: ComponentProps<"select">) {
  return <select className={clsx(controlClass, "h-10", className)} {...rest} />;
}

// ------------------------------------------------------------------ tables

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        {children}
      </table>
    </div>
  );
}

export function Th({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <th
      className={clsx(
        "border-b border-selected px-3 py-2 text-left text-xs font-normal text-ink-3",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <td className={clsx("border-b border-selected px-3 py-3 align-top", className)}>
      {children}
    </td>
  );
}

// ------------------------------------------------------------------ notes

/** The quiet explanatory line the design puts under tables and run cards. */
export function FootNote({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-relaxed text-ink-3">{children}</p>;
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-card border border-dashed border-line px-6 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      {body ? <p className="max-w-sm text-xs text-ink-3">{body}</p> : null}
      {action}
    </div>
  );
}
