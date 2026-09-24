"use client";

import clsx from "clsx";
import { useActionState, useState } from "react";
import { Check, Minus } from "lucide-react";
import { Button, Card, FootNote, Input, SectionLabel } from "@/components/ds";
import { connectAccount, type ConnectState } from "@/server/account-actions";

export type Connectable = {
  credentialType: string;
  displayName: string;
  allows: { grants: string[]; denies: string[] };
  fields: {
    name: string;
    label: string;
    description: string | null;
    secret: boolean;
    required: boolean;
  }[];
};

export function ConnectPanel({
  options,
  preselect,
}: {
  options: Connectable[];
  preselect?: string;
}) {
  const [selected, setSelected] = useState(
    options.find((item) => item.credentialType === preselect)?.credentialType ??
      options[0]?.credentialType ??
      "",
  );
  const [state, formAction, pending] = useActionState<ConnectState, FormData>(
    connectAccount,
    {},
  );

  const option = options.find((item) => item.credentialType === selected);

  return (
    <Card className="flex h-fit flex-col gap-4 p-4">
      <SectionLabel>Connect an account</SectionLabel>

      <div className="flex flex-wrap gap-1.5">
        {options.map((item) => (
          <button
            key={item.credentialType}
            type="button"
            onClick={() => setSelected(item.credentialType)}
            className={clsx(
              "rounded-full px-3 py-1.5 text-[13px]",
              item.credentialType === selected
                ? "bg-ink text-white"
                : "border border-line hover:bg-fill",
            )}
          >
            {item.displayName}
          </button>
        ))}
      </div>

      {option ? (
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="credentialType" value={option.credentialType} />
          <input type="hidden" name="displayName" value={option.displayName} />

          <div>
            <div className="text-sm font-medium">{option.displayName}</div>
            <div className="mt-2.5">
              <span className="text-xs text-ink-3">What this allows</span>
              <ul className="mt-1.5 flex flex-col gap-1.5 text-[13px]">
                {option.allows.grants.map((grant) => (
                  <li key={grant} className="flex items-center gap-2">
                    <Check size={14} strokeWidth={2} className="flex-none text-ready" />
                    {grant}
                  </li>
                ))}
                {option.allows.denies.map((deny) => (
                  <li key={deny} className="flex items-center gap-2 text-ink-2">
                    <Minus size={14} strokeWidth={2} className="flex-none text-ink-3" />
                    {deny}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="flex flex-col gap-3 border-t border-selected pt-3">
            {option.fields.length === 0 ? (
              <p className="text-[13px] text-ink-2">
                This service needs a sign-in flow the platform does not offer yet,
                so it cannot be connected here.
              </p>
            ) : (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[13px] font-medium">Label this account</span>
                  <Input
                    name="field.accountRef"
                    placeholder="name@company.com"
                    autoComplete="off"
                  />
                </label>
                {option.fields.map((field) => (
                  <label key={field.name} className="flex flex-col gap-1.5">
                    <span className="text-[13px] font-medium">
                      {field.label}
                      {field.required ? (
                        <span className="ml-1 font-normal text-ink-3">· required</span>
                      ) : null}
                    </span>
                    <Input
                      name={`field.${field.name}`}
                      type={field.secret ? "password" : "text"}
                      autoComplete="off"
                      required={field.required}
                    />
                    {field.description ? (
                      <span className="text-xs text-ink-3">{field.description}</span>
                    ) : null}
                  </label>
                ))}
              </>
            )}
          </div>

          <FootNote>
            Your keys are stored in an encrypted vault and injected only at the
            moment a run needs them. Products never contain secrets, and creators
            can never see yours.
          </FootNote>

          <div>
            <span className="text-xs text-ink-3">Use for</span>
            <div className="mt-1.5 flex gap-1.5">
              <label className="flex items-center gap-2 rounded-full border border-line px-3 py-1.5 text-[13px] has-checked:border-ink has-checked:bg-ink has-checked:text-white">
                <input
                  type="radio"
                  name="reusable"
                  value="one"
                  className="sr-only"
                />
                This product only
              </label>
              <label className="flex items-center gap-2 rounded-full border border-line px-3 py-1.5 text-[13px] has-checked:border-ink has-checked:bg-ink has-checked:text-white">
                <input
                  type="radio"
                  name="reusable"
                  value="all"
                  defaultChecked
                  className="sr-only"
                />
                Every product that asks
              </label>
            </div>
          </div>

          {state.error ? (
            <p className="text-[13px] text-danger-ink">{state.error}</p>
          ) : null}
          {state.done ? (
            <p className="text-[13px] text-ready-ink">Connected.</p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button type="reset" tone="secondary" size="sm">
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={pending || option.fields.length === 0}
            >
              {pending ? "Connecting…" : `Continue to ${option.displayName}`}
            </Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}
