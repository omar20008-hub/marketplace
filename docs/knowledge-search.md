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

**Google Cloud (M0 — outside the code)**
1. OAuth client (Web) with redirect `https://<domain>/api/oauth/google/callback`.
2. Consent screen in **Production**, not Testing (Testing expires refresh tokens in 7 days).
3. Scope `drive.readonly` is *restricted*: verification is required beyond 100 users
   (and may need a security assessment). Until then users see a warning screen.
4. Privacy policy page on the verified domain.
5. Verify the domain for push notifications (Search Console + API console "Domain
   verification"). A `*.up.railway.app` domain probably cannot be verified — use a
   custom domain.

**Environment**: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`
(https), `PUBLIC_URL` (only if n8n reaches the app at another address),
`EMBEDDINGS_DRIVER=gemini`, `GEMINI_API_KEY`, `SCHEDULE_TOKEN`.

**Database**: Postgres with pgvector. Migrations succeed without it (knowledge is
then reported unavailable); after installing it, run the `DO $$ … $$` block at the
end of the `knowledge` migration once.

**Clock**: something must call, with `x-schedule-token`, roughly every minute
`POST /api/knowledge/tick` (drains the queue, renews push channels, re-lists stale
folders) and daily `POST /api/accounts/keepalive`. `npm run worker` is the
long-running alternative wherever the source is available.

**n8n**: MP · Install Template must be the version that substitutes the two
placeholders (already published). Upload `templates/chat-with-your-files.json`.

## Operating it

- **Changing the embedding model** (`EMBEDDINGS_MODEL`, or driver): every file
  records the model that embedded it, and search ignores files from another model
  (they show as "being processed"). Run `npm run reindex` to queue exactly those.
  Vectors are 768 wide; a model that cannot produce 768 needs a migration.
- **Re-read everything** (`npm run reindex -- --all`, optionally `--source <id>`).
- **A file stuck "Failed"**: the reason is on the Files page; Retry re-queues it.
  After 5 attempts a job is dropped and the file is marked Failed, never left
  spinning.
- **A source "Needs reconnect"**: the Google connection died (revoked, or unused
  for 6 months). The user reconnects from the Files page or Connected accounts and
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
