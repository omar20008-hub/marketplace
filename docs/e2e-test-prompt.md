# Prompt: end-to-end test of "Chat with your files" in Chrome

Paste everything below the line into a NEW Claude Code session started on your own
machine, inside a local clone of this repository, with the Claude in Chrome
extension installed and connected.

---

## Goal
Run the first REAL end-to-end test of the "Chat with your files" product (RAG over a
user's Google Drive folder) on the live test platform, driving my own Chrome through
Claude in Chrome (tools named `mcp__claude-in-chrome__*`; read the `chrome-browser`
skill first if available). Report precisely what works and what breaks. Fix only
clear bugs in this repo; otherwise report.

Platform (test): https://marketplace-production-3f79.up.railway.app/  (login at /login)
Repo: this checkout, branch `main`. Read `docs/knowledge-search.md` first (architecture,
deploy checklist, operations). Read `AGENTS.md` too (this Next.js has breaking changes;
read `node_modules/next/dist/docs` before touching Next code).

## Context
Everything was built and unit-tested in a cloud session that could not reach Google or
the platform, so NOTHING has run against real Google / Gemini / pgvector yet.
- Google Drive is connected through the platform's own OAuth (`drive.readonly`, durable
  refresh token). Indexing runs from a Postgres job queue drained by
  `POST /api/knowledge/tick` (header `x-schedule-token`) or `npm run worker`. Push
  notifications (Drive `changes.watch`) need a verified https domain; otherwise folders
  are re-listed every 6 hours.
- Template: `templates/chat-with-your-files.json` (one on-demand chat agent whose only
  tool calls `POST {platform}/api/knowledge/search` with a per-installation key).
  MP · Install Template (n8n) substitutes `__MP_KNOWLEDGE_KEY__` and
  `__MP_PLATFORM_URL__`. Verified locally: the n8n validator accepts the file with no
  flags, and the substitution works.
- The product is flagged `usesKnowledge` at upload (the file contains
  `__MP_KNOWLEDGE_KEY__`); the setup wizard then shows a "Your files" step and
  `/workspace/<installationId>/files` shows indexing status.

## Before you start: ask me for / confirm (never guess, never print secrets in chat or commit them)
1. Platform logins: a CREATOR account (upload) and an ADMIN account (approve); may be the
   same user. I type passwords myself if asked.
2. The deployment already has: latest `main` deployed, migrations applied, Postgres with
   pgvector (and the last `DO $$` block of the `knowledge` migration run once), env vars
   `GOOGLE_CLIENT_ID/SECRET`, `GOOGLE_REDIRECT_URI` (https, registered in Google Cloud),
   `EMBEDDINGS_DRIVER=gemini`, `GEMINI_API_KEY`, `SCHEDULE_TOKEN`, and something calling
   `/api/knowledge/tick` about once a minute. If any is missing, STOP and tell me what to
   set; do not work around it.
3. A Google Drive test folder with 3–5 small files (a Google Doc, a PDF with a text
   layer, a .md/.txt) whose content I know. Ask me for 2 questions whose answers are in
   the files and 1 whose answer is NOT.
4. A Gemini credential I will enter in the wizard (the template needs `googlePalmApi`).
   I paste it; you never log it.

## Steps (screenshot each; note exact error text on any failure)
1. Log in as creator → Creator studio → upload `templates/chat-with-your-files.json`
   (title "Chat with your files", a category, a one-line summary). Expect: accepted,
   invocationMode on_demand, required credential Gemini only, no flagged nodes, no
   external hosts. If rejected, copy the exact reason (validator: n8n workflow
   "MP · Upload & Provision", node "Validate and Sanitize").
2. As admin → Admin review → approve. Expect status PUBLISHED.
3. As a normal user → open the product → Activate. Expect steps: Connections, Your
   files, Defaults, Where results go, Review. Enter the Gemini key; on "Your files" click
   Connect → complete Google consent IN MY BROWSER (I click Allow; an "unverified app"
   warning is expected until verification: Advanced → continue). Back in the wizard,
   browse to the test folder (also try pasting its link), select it, activate.
4. My workspace → the product → Files. Watch files go Waiting → Reading → Ready (the
   page refreshes itself). Note timings and any Failed/Skipped file with its reason. If
   nothing moves after ~2 minutes the tick/worker is probably not running: report that.
5. Run the product from My workspace / a chat. Ask the 2 answerable questions: check
   answers against the file content, and that citations (file name/link) are right and
   open the correct Drive file. Ask the unanswerable one: it must say it could not find
   it, not invent. Ask one in Arabic if the files allow.
6. Edit one file in Drive (change a fact) and add a new file. Without clicking anything,
   see how long until the Files page and answers reflect it (push needs a verified
   domain; otherwise up to 6 h, so use "Check now" and say which path you observed).
7. On the Files page try Retry (if a file failed), "Check now", and finally "Remove
   folder" (confirm deletes indexed data; the next question should say there are no files).
8. Optional: Connected accounts → disconnect Google; the Files page should show "Needs
   reconnect"; reconnecting restores syncing.

## Output
A short report: per step PASS/FAIL, exact error messages, screenshot paths, timings,
answer-quality notes (wrong / missing / hallucinated), and a prioritized list of problems
with the file/line you believe is responsible. If a fix is small and clearly correct,
make it on a branch `fix/rag-e2e-<topic>`, run `npx tsc --noEmit`,
`npx eslint src tests scripts` and `npx vitest run` (needs local Postgres; see
`tests/setup.ts`), and commit with a clear message. Do NOT push to `main`; do NOT create
a PR unless I ask.

## Safety
- Do not print or store secrets (DATABASE_URL, tokens, API keys, passwords, the `kb_…`
  key). Do not touch the production database directly. Do not delete products,
  installations or n8n workflows other than the ones you create for this test; clean up
  the test product/installation only if I say so.
- Do not click Google consent for me; ask me to.
