import Link from "next/link";
import {
  ArrowRight,
  Bot,
  CircleDollarSign,
  KeyRound,
  Plus,
  Route,
  ShieldCheck,
  Store,
  Workflow,
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

/** The twelve areas of work the product is built around. */
const AREAS = [
  { name: "Management", examples: "Daily summaries, KPI tracking, decision support" },
  { name: "Sales", examples: "Lead research, outreach drafts, CRM updates, forecasts" },
  { name: "Marketing", examples: "Content drafts, SEO briefs, campaign follow-up" },
  { name: "Customer service", examples: "FAQ answers, ticket triage, follow-ups" },
  { name: "Procurement", examples: "RFQs, comparing quotes, contract checks" },
  { name: "HR", examples: "CV screening, interview scheduling, onboarding steps" },
  { name: "Finance", examples: "Invoice handling, cash-flow views, payment alerts" },
  { name: "Operations", examples: "SOP lookup, data entry, recurring tasks" },
  { name: "Knowledge & documents", examples: "Search, Q&A, document summaries" },
  { name: "Personal work", examples: "Tasks, calendar, reminders" },
  { name: "Research & analysis", examples: "Market and industry scans, price tracking" },
  { name: "Communication", examples: "Email triage, meeting notes, action items" },
];

const STEPS = [
  {
    title: "Discover",
    body: "Browse by what you need done, not by the name of a tool.",
  },
  {
    title: "Add to workspace",
    body: "Pin a specific version. What it does, what it needs and where results go are shown up front.",
  },
  {
    title: "Connect",
    body: "Link only the accounts it requires. Many products run on platform credentials and need nothing extra.",
  },
  {
    title: "Run and keep the result",
    body: "Follow live status, then find every output in Results, ready to reuse.",
  },
];

const TRUST = [
  {
    icon: ShieldCheck,
    title: "Security checked",
    body: "Each version is scanned before it is listed, with secrets stripped from the payload.",
  },
  {
    icon: Store,
    title: "Platform approved",
    body: "A reviewer checks the product itself before anyone can add it to a workspace.",
  },
  {
    icon: Route,
    title: "Healthy",
    body: "A live signal from real runs. It changes when reliability changes.",
  },
  {
    icon: KeyRound,
    title: "Your accounts stay yours",
    body: "Secrets are encrypted at rest, and results go to the place you choose.",
  },
];

const FAQ = [
  {
    q: "Do I need to be technical?",
    a: "No. Describe the task in plain words. Setup asks you to connect the accounts a product needs, and nothing else.",
  },
  {
    q: "What do I pay for AI usage?",
    a: "Routine runs are included in your plan. Credits are spent only when you choose a specific model.",
  },
  {
    q: "Can I publish my own agent or workflow?",
    a: "Yes. Upload it in Creator studio. It goes through review before it is listed in the Marketplace.",
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
        <section className="mx-auto grid w-full max-w-[1040px] grid-cols-1 items-center gap-12 px-4 pt-12 pb-16 md:px-10 md:pt-20 lg:grid-cols-2 lg:gap-16">
          <div className="flex flex-col items-start">
            <Badge tone="neutral">Ready-to-run agents and workflows</Badge>

            <h1 className="mt-5 text-[36px] leading-[1.1] font-medium tracking-[-0.025em] md:text-[48px]">
              Run AI agents and workflows. Don&apos;t build them.
            </h1>
            <p className="mt-4 max-w-[480px] text-[16px] leading-relaxed text-ink-2">
              Builder is a marketplace of ready-made agents and workflows for the work
              your business already does. Describe the task, connect only what it
              needs, and get the result.
            </p>

            <div className="mt-8 flex w-full flex-col gap-2.5 sm:w-auto sm:flex-row sm:items-center">
              <ButtonLink href="/login" size="md" className="h-11 px-6">
                Get started
                <ArrowRight size={16} strokeWidth={1.8} />
              </ButtonLink>
              <ButtonLink href="/marketplace" tone="secondary" size="md" className="h-11 px-6">
                <Store size={16} strokeWidth={1.8} />
                Browse the Marketplace
              </ButtonLink>
            </div>
          </div>

          {/* A static picture of the composer and two products, as they appear in the app. */}
          <div aria-hidden="true" className="flex flex-col gap-3">
            <div className="rounded-composer border border-line bg-canvas p-5">
              <p className="text-[15px] text-ink-3">Describe the task…</p>
              <div className="mt-4 flex items-center gap-2">
                <span className="rounded-full border border-line px-3 py-1.5 text-xs text-ink-2">
                  Pick a product
                </span>
                <span className="rounded-full border border-line px-3 py-1.5 text-xs text-ink-2">
                  Schedule
                </span>
                <span className="ml-auto flex size-8 items-center justify-center rounded-full bg-ink text-white">
                  <ArrowRight size={14} strokeWidth={1.8} />
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <div className="flex flex-col gap-2.5 rounded-card border border-selected p-3.5">
                <div className="flex items-center justify-between">
                  <ProductGlyph category="Sales" kind="WORKFLOW" />
                  <Badge tone="ready">Ready</Badge>
                </div>
                <div>
                  <div className="text-sm font-medium">Weekly Sales Digest</div>
                  <div className="mt-0.5 text-xs text-ink-3">Workflow · last run 2 days ago</div>
                </div>
              </div>
              <div className="flex flex-col gap-2.5 rounded-card border border-selected p-3.5">
                <div className="flex items-center justify-between">
                  <ProductGlyph category="Operations" kind="AGENT" />
                  <Badge tone="ready">Ready</Badge>
                </div>
                <div>
                  <div className="text-sm font-medium">Inbox Triage Agent</div>
                  <div className="mt-0.5 text-xs text-ink-3">Agent · 41 runs</div>
                </div>
              </div>
            </div>
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

        {/* Use cases */}
        <section className="border-t border-line bg-sidebar px-4 py-20 md:px-10">
          <div className="mx-auto max-w-[1040px]">
            <p className="text-[13px] font-medium text-ink-3">Use cases</p>
            <h2 className="mt-2 max-w-[560px] text-[28px] leading-tight font-medium tracking-[-0.02em] md:text-[34px]">
              Twelve areas of work, ready to run.
            </h2>
            <p className="mt-3 max-w-[560px] text-[15px] text-ink-2">
              Start from the part of the business that is slowing you down.
            </p>

            <div className="mt-10 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
              {AREAS.map((area) => (
                <Link
                  key={area.name}
                  href="/marketplace"
                  className="flex flex-col gap-1.5 rounded-card border border-line bg-canvas p-4 hover:border-ink-3"
                >
                  <span className="text-[15px] font-medium text-ink">{area.name}</span>
                  <span className="text-[13px] leading-relaxed text-ink-2">{area.examples}</span>
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* Workflows and agents */}
        <section className="px-4 py-20 md:px-10">
          <div className="mx-auto max-w-[1040px]">
            <p className="text-[13px] font-medium text-ink-3">Two kinds of product</p>
            <h2 className="mt-2 max-w-[600px] text-[28px] leading-tight font-medium tracking-[-0.02em] md:text-[34px]">
              Workflows for the predictable. Agents for the open-ended.
            </h2>

            <div className="mt-10 grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="flex flex-col gap-4 rounded-card border border-line p-6">
                <span className="flex size-9 items-center justify-center rounded-row bg-fill text-ink">
                  <Workflow size={18} strokeWidth={1.8} />
                </span>
                <div>
                  <h3 className="text-[17px] font-medium">A fixed sequence, run the same way every time.</h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-2">
                    Good for reports, digests and moving data between tools.
                  </p>
                </div>
                <p className="mt-auto rounded-row bg-fill px-3.5 py-2.5 text-[13px] text-ink-2">
                  Example: Weekly Sales Digest pulls last week&apos;s deals and emails your team.
                </p>
              </div>

              <div className="flex flex-col gap-4 rounded-card border border-line p-6">
                <span className="flex size-9 items-center justify-center rounded-row bg-fill text-ink">
                  <Bot size={18} strokeWidth={1.8} />
                </span>
                <div>
                  <h3 className="text-[17px] font-medium">A goal, a model, and a fixed list of tools.</h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-2">
                    Good for triage, drafting and judgement calls, within the rules you set.
                  </p>
                </div>
                <p className="mt-auto rounded-row bg-fill px-3.5 py-2.5 text-[13px] text-ink-2">
                  Example: Inbox Triage Agent sorts mail and drafts replies.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* How it works */}
        <section className="border-t border-line bg-sidebar px-4 py-20 md:px-10">
          <div className="mx-auto max-w-[1040px]">
            <p className="text-[13px] font-medium text-ink-3">How it works</p>
            <h2 className="mt-2 max-w-[560px] text-[28px] leading-tight font-medium tracking-[-0.02em] md:text-[34px]">
              From a sentence to a finished result.
            </h2>

            <div className="mt-10 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((step, index) => (
                <div
                  key={step.title}
                  className="flex flex-col gap-3 rounded-card border border-line bg-canvas p-5"
                >
                  <span className="text-[13px] text-ink-3">0{index + 1}</span>
                  <div>
                    <h3 className="text-[15px] font-medium">{step.title}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-ink-2">{step.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Featured products, from the database */}
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
          <div className="mx-auto max-w-[1040px]">
            <p className="text-[13px] font-medium text-ink-3">Trust</p>
            <h2 className="mt-2 max-w-[560px] text-[28px] leading-tight font-medium tracking-[-0.02em] md:text-[34px]">
              Clear signals before you run anything.
            </h2>

            <div className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {TRUST.map((item) => (
                <div key={item.title} className="flex flex-col gap-3 rounded-card border border-line p-5">
                  <item.icon size={20} strokeWidth={1.8} className="text-ink" />
                  <h3 className="text-[15px] font-medium">{item.title}</h3>
                  <p className="text-sm leading-relaxed text-ink-2">{item.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Pricing note */}
        <section className="px-4 pb-20 md:px-10">
          <div className="mx-auto flex max-w-[1040px] flex-col gap-4 rounded-card border border-line p-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-row bg-fill text-ink">
                <CircleDollarSign size={18} strokeWidth={1.8} />
              </span>
              <p className="text-[15px] text-ink-2">
                Routine runs are included in your plan. Choosing a specific model spends credits.
              </p>
            </div>
            <ButtonLink href="/pricing" tone="secondary" size="sm" className="h-9 shrink-0">
              See pricing
            </ButtonLink>
          </div>
        </section>

        {/* FAQ */}
        <section className="border-t border-line bg-sidebar px-4 py-20 md:px-10">
          <div className="mx-auto max-w-[720px]">
            <h2 className="text-[28px] leading-tight font-medium tracking-[-0.02em] md:text-[34px]">
              Questions
            </h2>
            <div className="mt-8 flex flex-col gap-2.5">
              {FAQ.map((item) => (
                <details key={item.q} className="rounded-card border border-line bg-canvas px-5">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-[15px] font-medium">
                    {item.q}
                    <Plus size={16} strokeWidth={1.8} className="shrink-0 text-ink-3" />
                  </summary>
                  <p className="pb-4 text-sm leading-relaxed text-ink-2">{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* Closing call to action */}
        <section className="px-4 py-20 md:px-10">
          <div className="mx-auto flex max-w-[1040px] flex-col items-center gap-5 rounded-modal bg-fill px-6 py-14 text-center md:py-16">
            <h2 className="max-w-[520px] text-[26px] leading-tight font-medium tracking-[-0.02em] md:text-[32px]">
              Start with one task. See what it saves you.
            </h2>
            <div className="flex flex-col gap-2.5 sm:flex-row">
              <ButtonLink href="/login" size="md" className="h-11 px-6">
                Get started
                <ArrowRight size={16} strokeWidth={1.8} />
              </ButtonLink>
              <ButtonLink href="/creator" tone="secondary" size="md" className="h-11 px-6">
                Publish a product
              </ButtonLink>
            </div>
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
          <Link href="/creator" className="text-ink-3 hover:text-ink">
            Creator studio
          </Link>
          <Link href="/login" className="text-ink-3 hover:text-ink">
            Log in
          </Link>
        </nav>
      </footer>
    </div>
  );
}
