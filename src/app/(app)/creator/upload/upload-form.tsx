"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  Button,
  ButtonLink,
  Card,
  Field,
  FootNote,
  Input,
  PageTitle,
  Select,
  Textarea,
} from "@/components/ds";
import { uploadProduct, type UploadState } from "@/server/creator-actions";

const CATEGORIES = [
  "Marketing",
  "Sales",
  "Finance",
  "Operations",
  "HR",
  "Content",
  "Legal",
];

export function UploadForm() {
  const [state, formAction, pending] = useActionState<UploadState, FormData>(
    uploadProduct,
    {},
  );

  return (
    <div className="mx-auto max-w-[680px] px-5 py-5 lg:px-7">
      <nav className="text-[13px] text-ink-3">
        <Link href="/creator" className="text-ink-2 hover:text-ink">
          Creator studio
        </Link>
        <span> / Upload</span>
      </nav>

      <div className="mt-4">
        <PageTitle title="Upload a product" />
      </div>

      <form action={formAction} className="mt-6 flex flex-col gap-5">
        <Field label="Title" required>
          <Input name="title" required placeholder="Instagram Publisher" />
        </Field>

        <Field
          label="One line for the card"
          hint="Shown on the marketplace card and nowhere else."
        >
          <Input
            name="summary"
            placeholder="Writes captions from a product page and schedules the posts."
          />
        </Field>

        <Field
          label="Description"
          required
          hint="This is also the description the conversation uses to decide when to reach for your product, so write it for a reader who has never seen it."
        >
          <Textarea
            name="description"
            rows={4}
            required
            placeholder="Reads a product page, writes captions in your brand voice, schedules the posts."
          />
        </Field>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
          <Field label="Type">
            <Select name="kind" defaultValue="WORKFLOW">
              <option value="WORKFLOW">Workflow</option>
              <option value="AGENT">Agent</option>
            </Select>
          </Field>
          <Field label="Category">
            <Select name="category" defaultValue="Operations">
              {CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Action type"
            hint="Write products ask the user to confirm first."
          >
            <Select name="actionType" defaultValue="read">
              <option value="read">Read</option>
              <option value="write">Write</option>
            </Select>
          </Field>
        </div>

        <Field label="Workflow file" required>
          <input
            type="file"
            name="file"
            accept="application/json,.json"
            required
            className="w-full rounded-row border border-line px-3 py-2 text-sm file:mr-3 file:rounded-full file:border-0 file:bg-ink file:px-3 file:py-1.5 file:text-white"
          />
        </Field>

        <Card className="p-4">
          <p className="text-[13px] font-medium">What the check requires</p>
          <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-4 text-[13px] text-ink-2">
            <li>
              A fully exported n8n workflow, starting with a{" "}
              <span className="font-mono text-xs">
                When Executed by Another Workflow
              </span>{" "}
              trigger whose input fields are declared explicitly. Anything else is
              refused.
            </li>
            <li>
              No shell or filesystem components. Every node is checked against the
              allow-list.
            </li>
            <li>
              Any credential left in the file is stripped and turned into a
              connection slot. Your original file is not kept.
            </li>
          </ul>
        </Card>

        {state.error ? (
          <Card tone="danger" className="p-3.5">
            <p className="text-[13px] font-medium">This file was refused</p>
            <p className="mt-1 text-[13px] text-ink-2">{state.error}</p>
          </Card>
        ) : null}

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? "Checking…" : "Upload and check"}
          </Button>
          <ButtonLink href="/creator" tone="secondary">
            Cancel
          </ButtonLink>
        </div>

        <FootNote>
          Publishing happens after a reviewer approves the version. Your currently
          published version is unaffected while a new one is checked.
        </FootNote>
      </form>
    </div>
  );
}
