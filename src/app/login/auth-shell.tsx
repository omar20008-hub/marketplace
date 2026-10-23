import type { ReactNode } from "react";

/** The narrow, centred column the sign-in, sign-up and welcome pages share. */
export function AuthShell({
  title,
  lede,
  children,
}: {
  title: string;
  lede: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-[380px]">
        <div className="mb-8 flex items-center gap-2.5">
          <span className="flex size-[26px] items-center justify-center rounded-[8px] bg-ink text-sm font-semibold text-white">
            B
          </span>
          <span className="text-base font-semibold tracking-[-0.01em]">Builder</span>
        </div>

        <h1 className="text-[30px] leading-tight font-medium tracking-[-0.02em]">{title}</h1>
        <p className="mt-2 text-sm text-ink-2">{lede}</p>

        {children}
      </div>
    </div>
  );
}
