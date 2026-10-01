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
| Search | `server/knowledge/search.ts`, `api/knowledge/search` | Vector similarity, scoped by installation id inside the query; returns passages, a numbered `context`, and a `library` summary |
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
- [ ] `SCHEDULE_TOKEN` — the secret the clock below sends.
- [ ] `EMBEDDINGS_DRIVER=gemini` and `GEMINI_API_KEY`.
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

**The clock — without it nothing is ever indexed**
- [ ] Something calls `POST /api/knowledge/tick` **about once a minute**, with a
  header named `x-schedule-token` whose value is `SCHEDULE_TOKEN`. Nothing in the app
  does this itself: a Railway cron service, a GitHub Action, an n8n Schedule Trigger
  or any external scheduler will do. It drains the queue, renews push channels and
  re-lists stale folders. (`npm run worker` is the long-running alternative where the
  source is available; the production image has no worker, so it uses this.)
- [ ] Also daily: `POST /api/accounts/keepalive`, same header.
- **How to verify:** in Railway's HTTP logs, a `POST /api/knowledge/tick` with status
  `200` roughly every minute (a `401` means the token differs from `SCHEDULE_TOKEN`).
  If it is not running, a user's *Files* page shows "Processing has not started. The
  scheduled worker … may be stopped" once work has waited two minutes.

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
- **A file stuck "Failed"**: the reason is on the Files page; Retry re-queues it.
  After 5 attempts a job is dropped and the file is marked Failed, never left
  spinning.
- **A source "Needs reconnect"**: the Google connection died (revoked, unused for
  6 months, or — with the OAuth app in Testing — older than 7 days). The user reconnects from the Files page or Connected accounts and
  syncing resumes by itself.
- **Nothing found though files exist**: check `library` in the search response —
  pending/failed/unsupported counts and `needsReconnect` say why.

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
