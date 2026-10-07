# Knowledge search (RAG over a user's Google Drive)

An installed workflow can answer questions from a folder in the user's own Google
Drive. The platform — not n8n — connects to Drive, reads and indexes the files,
keeps them fresh, and serves search. The n8n template is a thin agent that calls
one HTTP endpoint.

```
Google Drive ──push──▶ /api/knowledge/drive-webhook ─┐
      ▲                                              ▼
      │ read-only                            KnowledgeJob queue (Postgres)
      │                                              │
  ConnectedAccount (OAuth, durable)          worker / /api/knowledge/tick
                                                     │  list · read · chunk · embed
                                                     ▼
n8n instance ──Bearer kb_…──▶ /api/knowledge/search ◀── KnowledgeChunk (pgvector)
```

## Pieces

| Piece | Where | Notes |
|---|---|---|
| Google sign-in | `lib/google-oauth.ts`, `api/oauth/google/*`, `server/google-account.ts` | `drive.readonly`, offline + PKCE, single-flight refresh, only `invalid_grant` expires a connection, daily keep-alive at `/api/accounts/keepalive` |
| Tables | `KnowledgeSource / File / Chunk / Job` | A source belongs to one installation; deleting the installation or the source deletes everything indexed |
| Queue | `server/knowledge/queue.ts` | `FOR UPDATE SKIP LOCKED` leases, dedupe, re-run if requested mid-flight, backoff 30s→32m, 5 attempts |
| Indexing | `server/knowledge/indexer.ts`, `lib/drive.ts`, `lib/chunking.ts`, `lib/embeddings.ts` | Docs/Slides/Sheets, text, md, csv, json, PDFs with a text layer. Others are shown as "Skipped" with a reason |
| Push | `server/knowledge/watch.ts`, `changes.ts`, `api/knowledge/drive-webhook` | Per-source `changes.watch` channel with a secret; a notification only queues a job that reads the change feed and syncs if it touches the folder tree |
| Safety net | `worker.ts` | Every source is re-listed every 6 h, so a missed notification costs freshness, never correctness |
| Search | `server/knowledge/search.ts`, `api/knowledge/search` | Vector similarity, scoped by installation id inside the query; returns passages, a numbered `context`, a `files` list (every searchable file, so "which files do you have?" is answerable) and a `library` summary |
| Keys | `server/knowledge/keys.ts` | `kb_…` per installation, only its SHA-256 is stored, new one on every activation, dead when uninstalled |
| Limits | `server/knowledge/limits.ts`, `Plan.knowledgeSources/Files` | Per user across installations; unreadable and removed files are free |
| UX | wizard "Your files" step, `/workspace/<id>/files`, `components/app/folder-picker.tsx` | Folder listing served by our own endpoint — no Drive token reaches the browser |
| Template | `templates/chat-with-your-files.json` | Placeholders `__MP_KNOWLEDGE_KEY__`, `__MP_PLATFORM_URL__` are filled in by MP · Install Template |

## Deploy checklist

A deployment is **not ready** until every box below is true. Each one has a way to
check it; the first thing to run is the status call at the end.

**Database**
- [ ] Migrations applied (Railway Pre-deploy command `npm run migrate` succeeded).
- [ ] Postgres has pgvector. Migrations succeed without it (knowledge is then
  reported unavailable); after installing it, run the `DO $$ … $$` block at the end
  of the `knowledge` migration once.

**Environment** (names exactly; values only ever in Railway, never in the repo)
- [ ] `GOOGLE_CLIENT_ID`
- [ ] `GOOGLE_CLIENT_SECRET`
- [ ] `GOOGLE_REDIRECT_URI` — **must match, character for character, the "Authorized
  redirect URI" registered for the OAuth client in Google Cloud.** It is the public
  address plus `/api/oauth/google/callback`, over https, no trailing slash, e.g.
  `https://marketplace-production-3f79.up.railway.app/api/oauth/google/callback`.
  Any difference gives Google's `redirect_uri_mismatch`. (If `PUBLIC_URL` is set,
  this may be left out and is derived as `<PUBLIC_URL>/api/oauth/google/callback`;
  the Google Cloud registration is still required.)
- [ ] `SECRETS_KEY` — 64 hex characters; the connection's refresh token is stored
  encrypted with it.
- [ ] `SCHEDULE_TOKEN` — the secret an outside clock (option c) or the status call sends; not needed by the built-in scheduler.
- [ ] `EMBEDDINGS_DRIVER=gemini` and `GEMINI_API_KEY`.
- [ ] `KNOWLEDGE_TICK_INTERVAL_SECONDS=60` — turns on the built-in scheduler (see the clock below).
- [ ] `PUBLIC_URL` — the app's public address (`https://…`, no path), used for every
  redirect and written into installed workflows. Only strictly needed if n8n
  reaches the app at an address other than `GOOGLE_REDIRECT_URI`'s origin.

If a Google setting is missing, *Connect* returns the person to where they were with
"Google sign-in is not set up on the server yet. Missing: <names>." (worked out from
the server's environment when the page renders, so it cannot be spoofed through the
URL), and the server log has `Google sign-in is not configured; missing settings:
<names>`. Names only, never values. Redirects are built from `PUBLIC_URL` / the
origin of `GOOGLE_REDIRECT_URI`, then the proxy's `x-forwarded-host` /
`x-forwarded-proto`, and only last from the request — behind a proxy the request says
`0.0.0.0:<port>`, which no browser can reach.

**The clock — without it nothing is ever indexed.** Indexing happens only when
something drains the queue, and nothing does by default. A deployment is **not
ready** until one of these three is in place (any one; they can be combined, because
a pass is safe to run concurrently with another):

- [ ] **(a) Built in — recommended.** Set `KNOWLEDGE_TICK_INTERVAL_SECONDS=60` (any
  value of 10 or more; unset or `0` means off). The server then runs the tick
  itself, in-process, once a minute: no HTTP call, no token, no second service.
  It starts when the production server boots (not during `next build`, not under
  tests, not in development unless `KNOWLEDGE_TICK_IN_DEV=true`), one pass at a time,
  and a Postgres advisory lock keeps two replicas — or a pass that overran — from
  running at once. A failed pass is logged (error kind only) and the next one runs.
  Needs a server that stays up (Railway: yes; a serverless host: use (c)).
  *How to verify:* the log has `Knowledge scheduler started: a tick every 60s` at
  boot and then a line `knowledge tick ok: queued=… ran=… failed=…` every minute;
  `GET /api/knowledge/status` shows `tick.lastAgeSeconds` under ~70.
- [ ] **(b) A second Railway service running the worker**, with the same
  environment as the app and start command `npm run worker` (a long-running loop;
  it needs the source and `tsx`, which the production image does not carry, so this
  means a service built from the repository rather than from the app's image).
  *Verify:* its log prints `queued … ran …` lines when there is work.
- [ ] **(c) An outside clock** calling `POST /api/knowledge/tick` about once a
  minute, with a header named `x-schedule-token` whose value is `SCHEDULE_TOKEN`
  (a cron service, a GitHub Action, an n8n Schedule Trigger). The endpoint's
  protection is unchanged. *Verify:* in Railway's HTTP logs a `POST
  /api/knowledge/tick` with status `200` roughly every minute (`401` means the
  token differs from `SCHEDULE_TOKEN`).

Whichever is used, also call `POST /api/accounts/keepalive` daily (same header,
outside clock). If none of the three is running, a user's *Files* page shows
"Processing has not started. The scheduled worker … may be stopped" once work has
waited two minutes, and `GET /api/knowledge/status` reports `queue.stalled: true`.

**Google Cloud**
- [ ] OAuth client (Web) with the redirect URI above.
- [ ] **Publishing status.** In *Testing*, Google expires refresh tokens after **7
  days**: every connection then shows **"Needs reconnect"** and indexing stops until
  the user reconnects. Only accounts listed under *Test users* can sign in at all
  (an unlisted account is refused by Google before it ever reaches this app). Use
  Testing only for trials, add every tester as a Test user, and move to **Production**
  for anything lasting.
- [ ] Scope `drive.readonly` is *restricted*: verification is required beyond 100
  users (and may need a security assessment). Until then users see a warning screen.
- [ ] Privacy policy page on the verified domain.
- [ ] For push notifications: the domain verified (Search Console + API console
  "Domain verification"). A `*.up.railway.app` domain probably cannot be verified —
  use a custom domain. Without push, folders are re-listed every 6 hours.

**n8n**: MP · Install Template must be the version that substitutes
`__MP_KNOWLEDGE_KEY__` and `__MP_PLATFORM_URL__` (already published). Upload
`templates/chat-with-your-files.json`.

**Check it all at once**
```bash
curl -s https://<domain>/api/knowledge/status -H "x-schedule-token: $SCHEDULE_TOKEN"
```
Returns `ok: true` when pgvector is present, every Google setting is in place and
the queue is being drained. Otherwise it says which: `google.missing` (names only),
`database.pgvector`, `tick.lastAgeSeconds` (null = never ticked) and
`queue.stalled`. `401` means the token is wrong. It never returns a value.

## Operating it

- **Changing the embedding model** (`EMBEDDINGS_MODEL`, or driver): every file
  records the model that embedded it, and search ignores files from another model
  (they show as "being processed"). Run `npm run reindex` to queue exactly those.
  Vectors are 768 wide; a model that cannot produce 768 needs a migration.
- **Re-read everything** (`npm run reindex -- --all`, optionally `--source <id>`).
- **Reading a failure in the log.** Each failed job prints two lines, e.g.
  `knowledge job failed: kind=INDEX_FILE type=embeddings_rate_limit attempt=2/5 retry_in=120s`
  then `knowledge job file: <name>` (or `… folder: <name>`), and the per-minute
  line carries the kinds: `knowledge tick ok: … failed=1 gaveUp=0 types=embeddings_rate_limit:1`.
  The `type` is a category, never the error's own text: `embeddings_rate_limit` /
  `embeddings_server_error` / `embeddings_network` / `embeddings_not_configured`,
  `drive_rate_limit` / `drive_forbidden` / `drive_server_error` / `drive_network`,
  `nul_byte_in_text`, `pdf_parse_error`, `timeout`, `network`, `database_error_<code>`.
  `retry_in` is the backoff (30 s, 2 m, 8 m, 32 m); after 5 attempts the line says
  `gave up` and the file becomes Failed.
- **Embedding rate limits (HTTP 429).** Gemini limits embedding requests per minute
  and per day, and a free-tier key hits both on a large PDF. The code reads what the
  API says (`Retry-After`, or `RetryInfo`/quota id in the body — never logged): a
  per-minute limit of up to ~25 s is waited out *inside* the call, so a big file is
  not restarted for a short pause; anything longer, and any daily limit, goes back to
  the queue, which retries a rate limit **12 times** (1 min doubling to 1 h, never
  sooner than the API asked) instead of the ordinary 5 (30 s … 32 min) — so a file
  survives a quota window rather than failing inside it. The Files page says "The
  embedding service is limiting requests … Retrying automatically."; after the last
  try, "Press Retry later, or raise the quota." (Retry re-queues it with fresh
  attempts.) Requests are sent in batches of 25. A folder with failed files shows
  "N failed" rather than "Up to date". The durable fix is quota: use a paid key, or
  raise the `gemini-embedding-001` limits in Google AI Studio.
  **Requests shrink to fit the token allowance.** The free tier also caps input
  *tokens* a minute (30K for `gemini-embedding-001`). A request of 25 dense chunks
  (Arabic, OCR text) can be over that by itself, and is then refused however long it
  waits — with the day's request count at zero. A per-minute refusal now halves the
  batch at once (25 → 12 → 8, never below 8) and keeps the smaller size for half an
  hour. Check AI Studio → Usage → Rate Limit: requests far under the limit with
  TPM near 30K points here.
  **Text is made storable before it is chunked** (`storableText`): a PDF's extracted
  text can carry NUL bytes and lone surrogates, and Postgres refuses a NUL
  (`22021 invalid byte sequence … 0x00`). That failure is classified `nul_byte_in_text`
  and the Files page shows only "Retrying after a temporary problem" with an ordinary
  (non-rate-limit) backoff, 30 s × 4ⁿ — a 32-minute next try is its signature.
  **Try again** (Files page) re-reads a file that was skipped because its text could
  not be read (unreadable, empty, no text layer) — for when the reader has improved
  since — and not one left out on purpose, a scratch file or an unsupported type.
  **Text files are decoded by their own encoding** (`src/lib/text-decode.ts`): UTF-8
  (with or without a BOM), UTF-16 by its BOM, and otherwise Windows-1256 when the
  bytes decode mostly to Arabic, Windows-1252 if not. Excel on an Arabic Windows saves
  "CSV (Comma delimited)" as Windows-1256; read as UTF-8 that is a run of replacement
  characters.
  **The chat agent survives Gemini's 503s.** `templates/chat-with-your-files.json` gives
  the agent 5 tries 5 s apart and a fallback model (`gemini-2.5-flash-lite`). The run
  log in n8n's `mp_runs` table showed "Service unavailable" from the instance's agent,
  which had neither. Instances already installed are copies of the template as it was,
  so they need the same two settings applied by hand.
  **Word, Excel and PowerPoint** (`.docx`, `.xlsx`, `.pptx`) are read by
  `src/lib/office-text.ts`: a small zip reader over `node:zlib` (no dependency) and the
  text parts of the XML. Word: paragraphs, tables (a row is its cells joined by ` | `),
  footnotes. Excel: every sheet under `## Sheet: <name>`, one row per line, cell values
  (not formulas) with shared strings resolved. PowerPoint: slides in order under
  `## Slide N`, with speaker notes. The archive is untrusted: parts are size-capped (a
  zip bomb is refused, not expanded), password-protected or ZIP64 archives are turned
  away, and no XML parser runs, so there is nothing to expand. Not supported: the old
  binary `.doc`/`.xls`/`.ppt`, images and charts inside the files, comments, tracked
  changes' deleted text, and Excel dates (shown as their serial number). A file once
  skipped for its type ("This file type cannot be read yet.") is read at the next sync
  after it becomes readable.
  **Unreadable text is not indexed** (`looksUnreadable`, `src/lib/text-quality.ts`): when
  20% or more of a file's visible characters are NUL/control characters, replacement
  characters, private-use code points or stray symbols (a PDF whose fonts have no
  Unicode mapping), the file is marked Skipped with a reason that points at an OCR
  copy. Garbage chunks would otherwise answer questions ahead of a good copy, since
  every chunk carries its file's name. **Leave out / Use again** (Files page) lets
  the owner exclude any file by hand: its chunks are deleted and it stays out, new
  versions included, until it is used again.
  **Indexing resumes instead of restarting.** A file is embedded and stored 25 chunks
  at a time. If a rate limit stops it part-way, the chunks stored so far stay (hidden:
  the file is not READY), `KnowledgeFile.partialRevision` records `<revision>:<chunk
  count>`, and the job is *deferred* — no attempt is spent — for the time the API asked.
  The next pass embeds only the rest. A changed file, or a changed text, starts over.
  Before this, a large PDF was embedded from its first chunk on every retry, never
  got past the per-minute limit, and spent the daily quota on repeats. When the
  provider says its *daily* quota is spent (`quotaId` …PerDay), the file waits for the
  next quota day (midnight Pacific) with the "allowance is used up" message instead of
  retrying every few minutes; a file bigger than the whole day's allowance is finished
  over several days.
- **A daily allowance of our own** (`EMBEDDINGS_DAILY_LIMIT`, off when unset). The
  free tier allows about 1000 embedded texts a day, and a large PDF spends hundreds.
  Set the variable a little under the real quota (searches embed one query each and
  are not counted) and indexing stops *on purpose* when the day's count is reached:
  files show "Today's embedding allowance is used up…" and are put off until the quota
  day turns over (midnight Pacific Time), without using up an attempt — so nothing
  fails and nothing needs Retry. The count is the chunks written to files indexed
  since the day began. A file bigger than the whole allowance is let through on a
  fresh day, so it is not stuck for ever.
- **Scratch files are not indexed**: names starting `tmp_` or `~$`, or ending `.tmp`
  (an OCR flow's temporary copy, an Office lock file) are listed as skipped, never
  embedded, and do not use the plan's file allowance. One that was already indexed
  is dropped on the next sync.
- **A file stuck "Failed"**: the reason is on the Files page; Retry re-queues it.
  After 5 attempts a job is dropped and the file is marked Failed, never left
  spinning.
- **A source "Needs reconnect"**: the Google connection died (revoked, unused for
  6 months, or — with the OAuth app in Testing — older than 7 days). The user reconnects from the Files page or Connected accounts and
  syncing resumes by itself.
- **Nothing found though files exist**: check `library` in the search response —
  pending/failed/unsupported counts and `needsReconnect` say why.

## The assistant's rules (template `chat-with-your-files`)

Files first, web only as a fallback. The agent calls **Search Files** on every
question; if the passages do not answer it, it rephrases once and calls **Web
Search** (Gemini with Google Search grounding, through the instance's own Gemini
credential — no extra key), says the answer is not in the user's files, and names
the source on the last line ("your files" / "the web" / both). It answers only
from tool output, never from memory, and treats tool output as data. A web search
costs one Gemini request from the same project quota as the chat model.

The main chat (MP · Orchestrator) lists every active on-demand installation as a
tool, so a question about files is routed to this assistant from there too; nothing
extra is configured per installation. Every message goes through the Orchestrator,
which has its own `web_search` tool (same grounding call) for questions that change
with time, passes file questions on whole, and ends each answer with the source line
the tool returned. Its chat model is `gemini-3.1-flash-lite` (a preview model with
20 requests/day on the free tier took the whole chat down), with 3 tries on
transient 503s.

## Data handling

Indexed text is a copy of the user's files, kept only for their own installation.
It is deleted when the folder is removed, when the installation is uninstalled, and
(with the user) by the cascade. Disconnecting Google revokes the token at Google,
stops the push channel, and leaves the copy for the user to keep or remove.

## Known limits / next steps

- Vector search only; no keyword (BM25) leg, no re-ranking. Exact-term queries
  (part numbers, names) are the likeliest miss.
- Sheets export only their first tab. DOCX/images are skipped (no OCR).
- Retrieval quality has not been measured on real customer files; build a small
  question set before promising accuracy.
- No streaming of indexing progress beyond the 4-second refresh on the Files page.
- Starter questions ("what can I ask?") need a model call on the platform.
