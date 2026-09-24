# Builder

The platform half of the workflow marketplace. n8n owns execution; this owns
everything a person sees or types.

Built from two sources:

- **The engineering handover reference** — the eight n8n workflows that already
  exist, their exact inputs and outputs, and the seven `mp_*` data tables.
- **The design canvas** — the design system and eleven screens.

## Running it

```bash
cp .env.example .env
npm install
npm run db:up             # Postgres on 5433, so it never fights an existing one
npx prisma migrate dev --name init
npm run db:seed
npm run dev
```

Then fill in two values in `.env` before signing in:

```bash
node -e "console.log('AUTH_SECRET=' + require('crypto').randomBytes(32).toString('base64url')); console.log('SECRETS_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
```

`AUTH_SECRET` signs session cookies. `SECRETS_KEY` encrypts connected-account
credentials at rest — changing or losing it makes every stored credential
unreadable and every user has to reconnect, so back it up separately from the
database.

Sign in at `/login` as:

| Account | Roles | What it shows |
| --- | --- | --- |
| `nora@acme.co` | user, admin | Home, Marketplace, workspace, results, accounts, admin review |
| `rami@studio.co` | user, creator | Creator studio with a failed submission to fix |

Password for both: `builder`.

If you already run Postgres and would rather use it, point `DATABASE_URL` at it
and skip `db:up`.

## The n8n boundary

`N8N_DRIVER` decides which implementation of the eight contracts is loaded.

**`mock`** (the default) runs everything in-process. It is not a stub that always
says yes — it enforces the same rules the real workflows do:

- the structural condition on an uploaded file (an Execute Workflow Trigger with
  `inputSource: workflowInputs` and explicit fields), or the upload is refused
- the node allow-list, so a shell or filesystem component is rejected by name
- the credential durability rule, so a type with no consent flow blocks publishing
- the deterministic argument validator, so a run never starts on guessed values
- the `..` path guard in storage

A screen that behaves correctly against the mock behaves correctly against the
instance. What the mock cannot do is execute a real user workflow, so `dispatch`
returns a plausible payload instead of real data.

**`live`** talks to the instance. Two things in the handover's open-decisions
list shape `src/lib/n8n/live.ts`:

- Upload, Install and Uninstall still use a **Form Trigger**, which answers with
  an HTML page rather than JSON. `postWebhook()` refuses a `text/html` reply with
  a clear error instead of half-parsing it. Convert those three to a Webhook
  Trigger and the same code starts working, unchanged.
- Dispatcher and Storage API use an **Execute Workflow Trigger** and have no URL
  at all, so they go through `POST /workflows/{id}/run` with the API key. If a
  parallel Webhook Trigger is added to each, swap `runWorkflow()` for
  `postWebhook()` and nothing else changes.

`N8N_API_KEY` has full control of the instance, including every other workflow
and credential on it. It is read in `src/lib/env.ts`, which is `server-only`, so
importing it from a Client Component is a build error rather than a leak.

## Credentials at rest

The connect screen promises the user that their keys live "in an encrypted vault
and [are] injected only at the moment a run needs them". `src/lib/secrets.ts` is
the half of that promise the database can keep: `ConnectedAccount.secretJson`
holds AES-256-GCM ciphertext, so a stolen dump is not a pile of live
credentials, and a tampered row fails loudly at decrypt instead of handing a
mangled token to a workflow. Plaintext exists only inside the `activate()` call
that hands it to n8n, and no query anywhere selects `secretJson` for a page.

What this does not defend against is anything that can read `SECRETS_KEY` — a
process with the key and the database has the plaintext, necessarily, because
the platform has to inject credentials into n8n at install time. Moving the key
into a KMS is the next step up and touches one function, `keyBytes()`.

## How the two halves line up

| The design calls it | The workflows call it |
| --- | --- |
| Product | a row in `mp_templates` |
| Add to workspace · Activate | `MP · Install Template` |
| My workspace | `mp_installations` |
| Results · Runs | `mp_runs` |
| Results · files | `mp_storage_objects` via `MP · Storage API` |
| Connected accounts | n8n credentials, one per installation |
| Creator studio submission | the reply from `MP · Upload & Provision` |
| Admin review queue | `mp_templates` where `status = in_review` |

### What the design needs that n8n has no answer for

These are the reason the platform has a database of its own rather than reading
the n8n data tables. Each one is platform-side, and each one is marked in
`prisma/schema.prisma` where it lands:

- **Plans, credits and quotas.** No workflow enforces a limit. `executeRun()`
  refuses over-quota runs here, before the dispatcher is called, so a blocked run
  costs nothing.
- **Ratings and reviews.** No table exists for them.
- **Schedules.** There is no per-user scheduling in the contracts.
- **Versions.** `mp_templates.version` is always 1 and there is no version chain;
  `ProductVersion` supplies the "pinned to v4.1" behaviour the design promises.
- **Agent vs Workflow, and categories.** `mp_templates` has `actionType` and
  nothing else to sort a marketplace by.
- **`Restricted` and `Suspended`.** Neither is in the workflow's status enum, so
  both are platform states, and `/api/n8n/sync` refuses to let a sync overwrite
  one.
- **Reusable connected accounts.** The design lets one account serve many
  products; n8n creates a credential per installation. `InstallationCredential`
  is the join that keeps both true.
- **Per-step progress.** The dispatcher returns one result with no trace, so
  `RunStep` rows are an outline the platform declares, not a trace it received.
  The code says so where they are made.
- **Cost per run.** `mp_runs` has no cost column.
- **The six-category check report.** Upload & Provision returns a flat accept or
  reject; the Creator Studio panel is the platform's presentation of that one
  reply, not a second scan.

### Decisions this repository takes, that the handover left open

- **Publish Sync → local mirror.** `/api/n8n/sync` takes pushed rows behind a
  shared token. A marketplace cannot search, filter, sort or count categories
  through the Data Table API on every request. The sweep's own hard-won lesson is
  honoured: a template the sync does not mention is left alone, so an outage can
  never read as a mass delete.
- **Partially ready is a platform state.** Install Template rightly refuses an
  incomplete credential set, so the platform records a `PARTIAL` installation and
  only calls the workflow once every connection exists.
- **Approval.** Publishing actually happens by activating the workflow inside
  n8n, and no API path exists for a reviewer to do it from here. `approve()`
  records the decision, moves the mirror and writes the audit entry; the panel
  links the reviewer to the workflow to finish. When that API path is agreed, the
  call goes in one function and nothing else changes.
- **Webhook auth.** Every outbound webhook carries `x-platform-token`, to be
  matched by Header Auth on the n8n side.

## Layout

```
prisma/schema.prisma     the platform database, with the boundary annotated
prisma/seed.ts           the catalogue, workspace, runs and review queue
src/lib/n8n/             contracts, the driver interface, mock and live
src/lib/readiness.ts     "does it work for me", computed in exactly one place
src/components/ds/       the design system: tokens in globals.css, parts here
src/server/*-actions.ts  every write, server-side
src/app/(app)/           the eleven screens
```

`readinessFor()` is the reason a badge on a card can never disagree with the
badge on the page it leads to.

## Honest gaps

- **Seeded counts are real, not decorative.** The design mock says "168 results"
  and "17 products"; this says whatever is in the table. A number that can be
  wrong is worth more than one that cannot be right.
- **Seeded artifacts have no bytes.** They describe runs from before this
  instance existed, so opening one returns a clear 404 rather than a fake file.
  Files produced by a run you start are real and open normally.
- **"Try with sample data" is not wired.** It has no contract behind it yet.
- **OAuth connections cannot be completed.** No consent flow exists — the mock
  refuses those types exactly as Install Template does, rather than pretending.
- **Storage destinations other than the platform are hidden, not disabled.** The
  adapters are `pending` in `mp_storage_adapters`, so they are not offered.
