"use client";

import clsx from "clsx";
import Link from "next/link";
import { useActionState, useState } from "react";
import { Check, Sparkles, X } from "lucide-react";
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  FootNote,
  Input,
  SectionLabel,
} from "@/components/ds";
import { activate, type ActivateState } from "@/server/install-actions";

export type SetupRequirement = {
  id: string;
  kind: "MODEL" | "CONNECTION" | "STORAGE";
  label: string;
  note: string | null;
  credentialType: string | null;
  providedBy: "PLATFORM" | "PLATFORM_OR_OWN" | "USER";
  connected: boolean;
  accountRef: string | null;
  fields: {
    name: string;
    label: string;
    description: string | null;
    secret: boolean;
    required: boolean;
  }[];
};

const STEPS = ["Connections", "Defaults", "Where results go", "Review"] as const;

export function SetupWizard({
  product,
  requirements,
  backends,
}: {
  product: {
    id: string;
    slug: string;
    title: string;
    version: string;
    invocationMode: string;
  };
  requirements: SetupRequirement[];
  backends: { backend: string; label: string }[];
}) {
  const [step, setStep] = useState(0);
  const [openForm, setOpenForm] = useState<string | null>(null);
  const [filled, setFilled] = useState<Record<string, boolean>>({});
  const [state, formAction, pending] = useActionState<ActivateState, FormData>(
    activate,
    {},
  );

  const mine = requirements.filter((r) => r.providedBy === "USER");
  const platform = requirements.filter((r) => r.providedBy !== "USER");
  const left = mine.filter((r) => !r.connected && !filled[r.id]).length;

  return (
    <div className="flex min-h-full items-start justify-center bg-ink/5 px-4 py-6 md:py-10">
      <form
        action={formAction}
        className="w-full max-w-[640px] rounded-modal border border-selected bg-canvas shadow-[0_18px_60px_rgba(0,0,0,0.12)]"
      >
        <input type="hidden" name="productId" value={product.id} />

        <header className="flex items-center justify-between gap-3 px-6 pt-5 pb-3">
          <h1 className="text-base font-medium">
            Activate {product.title}{" "}
            <span className="font-normal text-ink-3">· v{product.version}</span>
          </h1>
          <Link
            href={`/marketplace/${product.slug}`}
            aria-label="Close"
            className="flex size-8 items-center justify-center rounded-full text-ink-2 hover:bg-fill"
          >
            <X size={18} strokeWidth={1.8} />
          </Link>
        </header>

        <nav className="flex gap-1 overflow-x-auto px-6 pb-3">
          {STEPS.map((label, index) => (
            <button
              key={label}
              type="button"
              onClick={() => setStep(index)}
              className={clsx(
                "rounded-full px-3 py-1.5 text-[13px] whitespace-nowrap",
                index === step
                  ? "bg-fill font-medium text-ink"
                  : "text-ink-2 hover:text-ink",
              )}
            >
              {label}
            </button>
          ))}
        </nav>

        {/*
          Every step stays mounted and inactive ones are hidden, rather than
          rendered conditionally. A step that unmounts takes its inputs out of
          the form with it, so walking to Review would submit without the
          connection details the first step just collected.
        */}
        <div className="border-t border-selected px-6 py-5">
          <div className={step === 0 ? "" : "hidden"}>
            <div className="flex flex-col gap-5">
              <div>
                <p className="text-sm font-medium">
                  {left === 0
                    ? "Everything is connected"
                    : `${left} connection${left > 1 ? "s" : ""} left before you can run`}
                </p>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
                  The platform already provides the AI model and file access. Only
                  the connections below are tied to your own account.
                </p>
              </div>

              {platform.length > 0 ? (
                <div>
                  <SectionLabel className="text-ink-3">
                    Provided by the platform — nothing to do
                  </SectionLabel>
                  <div className="mt-2.5 flex flex-col gap-2">
                    {platform.map((requirement) => (
                      <Card
                        key={requirement.id}
                        className="flex flex-wrap items-center gap-3 p-3"
                      >
                        <span className="flex size-9 flex-none items-center justify-center rounded-row bg-fill text-xs font-medium text-ink-2">
                          {requirement.kind === "MODEL"
                            ? "AI"
                            : requirement.label.slice(0, 2)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium">
                            {requirement.label}
                          </div>
                          <div className="mt-0.5 text-xs text-ink-3">
                            {requirement.kind === "MODEL"
                              ? "Included in your plan. Picking a specific model would spend credits."
                              : requirement.providedBy === "PLATFORM_OR_OWN"
                                ? "Platform connection · you can switch to your own account"
                                : "Platform connection · no action needed"}
                          </div>
                        </div>
                        {requirement.providedBy === "PLATFORM_OR_OWN" ? (
                          <Link href="/accounts" className="text-[13px]">
                            Use my account
                          </Link>
                        ) : null}
                        <Badge tone="ready">Ready</Badge>
                      </Card>
                    ))}
                  </div>
                </div>
              ) : null}

              {mine.length > 0 ? (
                <div>
                  <SectionLabel className="text-ink-3">
                    Needs your account
                  </SectionLabel>
                  <div className="mt-2.5 flex flex-col gap-2">
                    {mine.map((requirement) => {
                      const done = requirement.connected || filled[requirement.id];
                      return (
                        <Card key={requirement.id} className="p-3">
                          <div className="flex flex-wrap items-center gap-3">
                            <span className="flex size-9 flex-none items-center justify-center rounded-row bg-fill text-xs font-medium text-ink-2">
                              {requirement.label.slice(0, 2).toUpperCase()}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-medium">
                                {requirement.label}
                              </div>
                              <div className="mt-0.5 text-xs leading-snug text-ink-3">
                                {done
                                  ? `Connected${requirement.accountRef ? ` · ${requirement.accountRef}` : ""}. Revoke any time from Connected accounts.`
                                  : "Used on your behalf while a run needs it. Revoke any time from Connected accounts."}
                              </div>
                            </div>
                            {done ? (
                              <Badge tone="ready">
                                <Check size={12} strokeWidth={2.4} />
                                Connected
                              </Badge>
                            ) : (
                              <Button
                                type="button"
                                size="sm"
                                onClick={() =>
                                  setOpenForm(
                                    openForm === requirement.id ? null : requirement.id,
                                  )
                                }
                              >
                                Connect
                              </Button>
                            )}
                          </div>

                          {/* Stays open while it is being filled in. Closing it on
                              the first keystroke would unmount the field holding
                              the secret the user just typed. */}
                          {openForm === requirement.id && !requirement.connected ? (
                            <div className="mt-3 flex flex-col gap-3 border-t border-selected pt-3">
                              {requirement.fields.length === 0 ? (
                                <p className="text-[13px] text-ink-2">
                                  This connection needs a sign-in flow that the
                                  platform does not offer yet.
                                </p>
                              ) : (
                                requirement.fields.map((field) => (
                                  <label
                                    key={field.name}
                                    className="flex flex-col gap-1.5"
                                  >
                                    <span className="text-[13px] font-medium">
                                      {field.label}
                                      {field.required ? (
                                        <span className="ml-1 font-normal text-ink-3">
                                          · required
                                        </span>
                                      ) : null}
                                    </span>
                                    <Input
                                      name={`cred.${requirement.credentialType}.${field.name}`}
                                      type={field.secret ? "password" : "text"}
                                      autoComplete="off"
                                      onChange={(event) =>
                                        setFilled((current) => ({
                                          ...current,
                                          [requirement.id]:
                                            event.target.value.length > 0,
                                        }))
                                      }
                                    />
                                    {field.description ? (
                                      <span className="text-xs text-ink-3">
                                        {field.description}
                                      </span>
                                    ) : null}
                                  </label>
                                ))
                              )}
                              <FootNote>
                                Stored encrypted and injected only at the moment a
                                run needs it. Products never contain secrets, and
                                creators can never see yours.
                              </FootNote>
                            </div>
                          ) : null}
                        </Card>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <div className={step === 1 ? "" : "hidden"}>
            <div className="flex flex-col gap-3">
              <SectionLabel>Defaults</SectionLabel>
              <p className="text-[13px] leading-relaxed text-ink-2">
                Every input this product declares is asked for at run time, so
                there is nothing to fix up front. The model stays on{" "}
                <span className="font-medium text-ink">auto</span>, which is
                included in your plan — choosing a specific one spends credits.
              </p>
              <Card className="flex items-center gap-3 p-3">
                <Sparkles size={17} strokeWidth={1.8} className="text-ink-2" />
                <span className="flex-1 text-sm">Model</span>
                <Badge tone="platform">Auto · included</Badge>
              </Card>

              {product.invocationMode === "scheduled" ? (
                <Card className="flex flex-col gap-2 p-3">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[13px] font-medium">Schedule</span>
                    <Input
                      name="schedule"
                      type="text"
                      autoComplete="off"
                      placeholder="0 9 * * *"
                    />
                    <span className="text-xs text-ink-3">
                      A cron expression for when this runs on its own. Leave blank
                      to use the product&apos;s own default schedule.
                    </span>
                  </label>
                </Card>
              ) : null}
            </div>
          </div>

          <div className={step === 2 ? "" : "hidden"}>
            <div className="flex flex-col gap-3">
              <SectionLabel>Where results go</SectionLabel>
              <div className="flex flex-col gap-2">
                {backends.map((backend, index) => (
                  <label
                    key={backend.backend}
                    className="flex items-center gap-3 rounded-card border border-selected p-3"
                  >
                    <input
                      type="radio"
                      name="storageBackend"
                      value={backend.backend}
                      defaultChecked={index === 0}
                      className="accent-ink"
                    />
                    <span className="flex-1 text-sm">{backend.label}</span>
                    {index === 0 ? <Badge tone="platform">Default</Badge> : null}
                  </label>
                ))}
              </div>
              <FootNote>
                Only destinations with a working adapter are listed. The rest are
                not offered until they exist.
              </FootNote>
            </div>
          </div>

          <div className={step === 3 ? "" : "hidden"}>
            <div className="flex flex-col gap-3">
              <SectionLabel>Review</SectionLabel>
              <ul className="flex flex-col gap-2 text-sm">
                {requirements.map((requirement) => {
                  const done =
                    requirement.providedBy !== "USER" ||
                    requirement.connected ||
                    filled[requirement.id];
                  return (
                    <li
                      key={requirement.id}
                      className="flex items-center justify-between gap-3 border-b border-selected pb-2"
                    >
                      <span>{requirement.label}</span>
                      <Badge tone={done ? "ready" : "partial"}>
                        {done ? "Ready" : "Not connected"}
                      </Badge>
                    </li>
                  );
                })}
              </ul>
              <FootNote>
                Adding pins you to v{product.version}. You choose when to upgrade.
              </FootNote>
            </div>
          </div>

          {state.error ? (
            <p className="mt-4 text-[13px] text-danger-ink">{state.error}</p>
          ) : null}
        </div>

        <footer className="flex flex-wrap items-center gap-3 border-t border-selected px-6 py-4">
          <p className="min-w-0 flex-1 text-xs text-ink-3">
            You can leave now — it stays in My workspace as Partially ready.
          </p>
          <ButtonLink
            href={`/marketplace/${product.slug}`}
            tone="secondary"
            size="sm"
          >
            Later
          </ButtonLink>
          {step < STEPS.length - 1 ? (
            <Button type="button" size="sm" onClick={() => setStep(step + 1)}>
              Next
            </Button>
          ) : (
            <Button type="submit" size="sm" disabled={pending}>
              {pending
                ? "Activating…"
                : left === 0
                  ? "Activate"
                  : `Activate — ${left} left`}
            </Button>
          )}
        </footer>
      </form>
    </div>
  );
}
