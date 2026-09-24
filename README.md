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

## Tests

```bash
npm run test:db:setup     # once: creates <your database>_test and migrates it
npm test
```

The suite runs against the mock driver and a database of its own, derived from
`DATABASE_URL` by appending `_test` so there is no second connection string to
keep in step. `TEST_DATABASE_URL` overrides it. The tests that exercise the
server actions clear their tables between cases, which is the whole reason they
are kept off the development database.

What it covers, and why those:

- **`readinessFor()`** — the one function every badge on every screen goes
  through. Each case is one of the distinctions it draws, and the precedence
  between them: suspended beats the plan limit, an expired account reads as
  blocked once installed but as a setup step before that.
- **The mock driver** — one test per rule the README claims it enforces. The
  claim that a screen behaving correctly against the mock behaves correctly
  against the instance is only worth something if the mock really does refuse
  what the instance refuses.
- **The live driver**, with `fetch` stubbed — above all, that a `text/html`
  reply is refused with an error naming the Form Trigger. Those tests are the
  contract that converting the three workflows has to satisfy, so switching to
  `N8N_DRIVER=live` is a configuration change rather than a debugging session.
- **Sessions and passwords** — that a forged, unsigned, re-keyed or expired
  cookie is refused, and that `requireRole` sends a signed-in user without the
  role home rather than to the sign-in page. `readSession()` is the single
  place a user id enters the system, so every ownership check downstream is
  only as good as it refusing what it should.
- **Every server action**, against real Postgres — each one re-checks ownership
  against the session rather than trusting an id in the form, because an action
  is reachable by direct POST whether or not the button that calls it is on
  screen. So each has a test that points it at another user's row and expects
  nothing to happen.
- **`executeRun()` and `activate()`** — that every refusal happens before the
  dispatcher is called and costs the user nothing, and that an incomplete
  credential set records a `PARTIAL` installation instead of calling Install
  Template.
- **Review decisions** — that a blocker cannot be waved through with a good
  enough reason, that a rejection leaves a live version live rather than
  pulling it out from under the people running it, and that no decision lands
  without an audit entry.
- **`lib/cron.ts`** — the day-of-month/day-of-week OR rule, steps, month and
  year rollover, and 29 February. A wrong answer here is invisible: the
  schedule simply fires at a time nobody asked for, a week later.
- **The tick**, against real Postgres — that a missed window fires once rather
  than once per miss, that two concurrent ticks fire a due schedule exactly
  once, and that a row with no next time is scheduled rather than fired.

### End to end

```bash
npm run build
npm run test:e2e
```

Every bug found in this codebase so far surfaced by driving the built app in a
browser, not by a unit test — a download link that fetched the file on hover, a
wizard that dropped the inputs it had just collected, a schedule form that saved
a different cadence than the one on screen. Each was about how the browser and
the framework behave together rather than about what a function returns, so
`e2e/` keeps that coverage instead of leaving it to whoever remembers to click.

Two of those specs are regression guards, and both were checked by putting the
bug back and watching them fail. The suite signs in, writes and deletes rows,
and expects the seeded catalogue, so point it at a development database.

Playwright starts the app itself and reuses one that is already running. It
needs a browser: `npx playwright install chromium`, or set
`PLAYWRIGHT_CHROMIUM_PATH` if the machine already has one.

The eleven screens have no component tests. Next's own guide recommends
end-to-end testing for async Server Components, which is what `e2e/` is.

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

## Schedules

A schedule is a row in `Schedule`: an installation, a five-field cron, and the
inputs each firing runs with.

**Why the inputs are stored.** Every product declares what it needs, and a
firing at 07:00 has nobody to ask. So the schedule form collects whatever the
product marks required, once, and `executeRun()` gets it on every firing.
Without that, each run would come straight back as "needs input".

**Times are UTC**, and the labels say so. There is no per-user time zone: that
needs a column and a decision about what a daily 02:30 means on the night a zone
skips 02:30 altogether, and neither is guessed at here.

**Nothing in the app keeps time.** Next has no durable timer — an interval in
the server dies with the process and fires twice behind a load balancer — so
something outside calls the heartbeat, about once a minute:

```bash
curl -fsS -X POST https://example.com/api/schedules/tick \
  -H "x-schedule-token: $SCHEDULE_TOKEN"
```

A cron daemon, a platform cron, a GitHub Action or an n8n Schedule Trigger all
do equally well; the endpoint does not care which. It takes no session, because
each schedule's owner is read from its own row — which is exactly why it takes
`SCHEDULE_TOKEN`, and why an empty token disables it rather than leaving it
open. In development, `npm run scheduler` polls it for you and prints what each
tick did.

Calling it more often than the schedules need is harmless: a schedule that is
not due is not touched.

**A missed window fires once, not once per miss.** The next due time is computed
from now, not from the time that was missed, so a daily schedule after a week of
downtime runs once and resumes. Catching up seven times would be a surprise; on
an hourly schedule it would be a stampede.

**Two ticks cannot double-fire one schedule.** Claiming a schedule is a
compare-and-swap on `nextRunAt`, so of two overlapping ticks one takes it and
the other moves on.

**A firing is refused the same way a person would be refused.** The tick decides
nothing itself: it hands every firing to `executeRun()`, the same path as the
Run button, so a schedule meets the same readiness check, plan limit and
argument validator, and a refused run costs nothing.

`lib/cron.ts` reads a documented subset and throws on anything outside it,
including the Quartz extensions (`L`, `W`, `#`, `?`) and six-field expressions.
A schedule that cannot be read can never fire, so the tick disables it and puts
the reason in `lastStatus` rather than failing quietly once a minute forever.

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
- **Schedules.** There is no per-user scheduling in the contracts, so the
  cadence, the saved inputs and the record of each firing all live here. See
  **Schedules** below.
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
src/lib/cron.ts          when a schedule next comes round
src/server/run-engine.ts starting a run — not an action module, deliberately
src/server/scheduler.ts  the tick: run whatever is due
scripts/scheduler.ts     the development heartbeat
src/components/ds/       the design system: tokens in globals.css, parts here
src/server/*-actions.ts  every write, server-side
src/app/(app)/           the eleven screens
tests/                   the unit suite, and the script that makes its database
e2e/                     the browser suite: the screens, and two regressions
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
- **Schedules run in UTC only.** The labels say so rather than implying local
  time, but someone outside UTC has to do the arithmetic themselves.
- **A schedule's saved inputs are fixed once set.** There is no edit — the way
  to change them is to delete the schedule and make it again.
- **Nothing retries a failed firing.** It is recorded and the schedule waits for
  its next window, rather than backing off and trying again.
