import Link from "next/link";
import {
  ArrowRight,
  KeyRound,
  MessageSquare,
  Route,
  ShieldCheck,
  Store,
  Wallet,
} from "lucide-react";
import { Badge, ButtonLink } from "@/components/ds";
import { GuestChat } from "@/components/app/guest-chat";
import { ProductGlyph } from "@/components/app/product-glyph";

export type FeaturedProduct = {
  slug: string;
  title: string;
  summary: string;
  category: string;
  kind: "AGENT" | "WORKFLOW";
};

const SUGGESTIONS = [
  "Summarise this week's sales and send it to Teams",
  "Turn this spreadsheet into an expense report",
  "Draft 10 captions from our product page",
];

const STEPS = [
  {
    icon: MessageSquare,
    title: "Describe the task",
    body: "Say what you need in plain words. No forms, no workflow diagrams.",
  },
  {
    icon: Route,
    title: "We find the right tool",
    body: "We match it to an agent or workflow you already own, or suggest one from the Marketplace.",
  },
  {
    icon: KeyRound,
    title: "Connect once, run anytime",
    body: "Link the accounts it needs a single time. After that, every run uses them without asking again.",
  },
];

const TRUST = [
  {
    icon: ShieldCheck,
    title: "Reviewed before it is listed",
    body: "Every Marketplace product is checked before anyone can install it.",
  },
  {
    icon: KeyRound,
    title: "Credentials stay encrypted",
    body: "Connected-account secrets are encrypted at rest and never shown back to you.",
  },
  {
    icon: Wallet,
    title: "Clear about what costs credits",
    body: "Routine runs are included in your plan. Only choosing a specific model spends credits.",
  },
];

export function GuestLanding({ products }: { products: FeaturedProduct[] }) {
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex h-16 items-center justify-between px-4 md:px-10">
        <Link href="/" className="flex items-center gap-2.5 text-ink">
          <span className="flex size-[26px] items-center justify-center rounded-[8px] bg-ink text-sm font-semibold text-white">
            B
          </span>
          <span className="text-base font-semibold tracking-[-0.01em]">Builder</span>
        </Link>

        <nav className="flex items-center gap-1 sm:gap-2">
          <Link
            href="/marketplace"
            className="hidden h-9 items-center rounded-row px-3 text-sm text-ink-2 hover:text-ink sm:inline-flex"
          >
            Marketplace
          </Link>
          <Link
            href="/pricing"
            className="hidden h-9 items-center rounded-row px-3 text-sm text-ink-2 hover:text-ink sm:inline-flex"
          >
            Pricing
          </Link>
          <ButtonLink href="/login" tone="secondary" size="sm" className="h-[34px]">
            Log in
          </ButtonLink>
        </nav>
      </header>

      <main className="flex flex-1 flex-col">
        {/* Hero */}
        <section className="flex flex-col items-center px-4 pt-14 pb-16 text-center md:px-10 md:pt-24">
          <Badge tone="plan">Agents and workflows you can run</Badge>

          <h1 className="mt-5 max-w-[760px] text-[36px] leading-[1.1] font-medium tracking-[-0.025em] md:text-[52px]">
            Get the work done with agents you can trust.
          </h1>
          <p className="mt-4 max-w-[560px] text-[16px] leading-relaxed text-ink-2 md:text-[17px]">
            Describe a task in plain words. Builder matches it to a ready-made agent
            or workflow from the Marketplace, runs it on the accounts you connect,
            and shows you what happened.
          </p>

          <div className="mt-8 flex w-full flex-col items-stretch gap-2.5 sm:w-auto sm:flex-row sm:items-center">
            <ButtonLink href="/login" size="md" className="h-11 px-6">
              Get started
              <ArrowRight size={16} strokeWidth={1.8} />
            </ButtonLink>
            <ButtonLink href="/marketplace" tone="secondary" size="md" className="h-11 px-6">
              <Store size={16} strokeWidth={1.8} />
              Browse the Marketplace
            </ButtonLink>
          </div>
        </section>

        {/* Try it */}
        <section className="flex flex-col items-center px-4 pb-20 md:px-10">
          <div className="w-full max-w-[720px]">
            <h2 className="text-center text-[20px] font-medium tracking-[-0.01em]">
              Try it without an account
            </h2>
            <p className="mt-1.5 text-center text-sm text-ink-2">
              Ask a question now. Running a product you own takes an account.
            </p>
            <GuestChat className="mt-6" suggestions={SUGGESTIONS} />
          </div>
        </section>

        {/* How it works */}
        <section className="border-t border-line bg-sidebar px-4 py-20 md:px-10">
          <div className="mx-auto max-w-[1040px]">
            <p className="text-[13px] font-medium text-ink-3">How it works</p>
            <h2 className="mt-2 max-w-[560px] text-[28px] leading-tight font-medium tracking-[-0.02em] md:text-[34px]">
              From a sentence to a finished task, in three steps.
            </h2>

            <div className="mt-10 grid grid-cols-1 gap-3 md:grid-cols-3">
              {STEPS.map((step, index) => (
                <div
                  key={step.title}
                  className="flex flex-col gap-3 rounded-card border border-line bg-canvas p-5"
                >
                  <div className="flex items-center justify-between">
                    <span className="flex size-9 items-center justify-center rounded-row bg-fill text-ink">
                      <step.icon size={18} strokeWidth={1.8} />
                    </span>
                    <span className="text-[13px] text-ink-3">0{index + 1}</span>
                  </div>
                  <div>
                    <h3 className="text-[15px] font-medium">{step.title}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-ink-2">{step.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Featured products */}
        {products.length > 0 ? (
          <section className="px-4 py-20 md:px-10">
            <div className="mx-auto max-w-[1040px]">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="text-[13px] font-medium text-ink-3">Marketplace</p>
                  <h2 className="mt-2 text-[28px] leading-tight font-medium tracking-[-0.02em] md:text-[34px]">
                    Ready to run today
                  </h2>
                </div>
                <Link href="/marketplace" className="shrink-0 text-[13px]">
                  See all
                </Link>
              </div>

              <div className="mt-8 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {products.map((product) => (
                  <Link
                    key={product.slug}
                    href={`/marketplace/${product.slug}`}
                    className="flex flex-col gap-3 rounded-card border border-selected p-4 hover:border-line"
                  >
                    <div className="flex items-center justify-between">
                      <ProductGlyph category={product.category} kind={product.kind} />
                      <span className="text-xs text-ink-3">{product.category}</span>
                    </div>
                    <div>
                      <div className="text-sm font-medium">{product.title}</div>
                      <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-ink-2">
                        {product.summary}
                      </p>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          </section>
        ) : null}

        {/* Trust */}
        <section className="border-t border-line px-4 py-20 md:px-10">
          <div className="mx-auto grid max-w-[1040px] grid-cols-1 gap-10 md:grid-cols-3 md:gap-8">
            {TRUST.map((item) => (
              <div key={item.title} className="flex flex-col gap-3">
                <item.icon size={20} strokeWidth={1.8} className="text-ink" />
                <h3 className="text-[15px] font-medium">{item.title}</h3>
                <p className="text-sm leading-relaxed text-ink-2">{item.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Closing call to action */}
        <section className="px-4 pb-20 md:px-10">
          <div className="mx-auto flex max-w-[1040px] flex-col items-center gap-5 rounded-modal bg-fill px-6 py-14 text-center md:py-16">
            <h2 className="max-w-[520px] text-[26px] leading-tight font-medium tracking-[-0.02em] md:text-[32px]">
              Start with one task. See what it saves you.
            </h2>
            <ButtonLink href="/login" size="md" className="h-11 px-6">
              Get started
              <ArrowRight size={16} strokeWidth={1.8} />
            </ButtonLink>
          </div>
        </section>
      </main>

      <footer className="flex flex-col gap-4 border-t border-line px-4 py-8 text-[13px] text-ink-3 md:flex-row md:items-center md:justify-between md:px-10">
        <span>© {new Date().getFullYear()} Builder</span>
        <nav className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <Link href="/marketplace" className="text-ink-3 hover:text-ink">
            Marketplace
          </Link>
          <Link href="/pricing" className="text-ink-3 hover:text-ink">
            Pricing
          </Link>
          <Link href="/login" className="text-ink-3 hover:text-ink">
            Log in
          </Link>
        </nav>
      </footer>
    </div>
  );
}
