@AGENTS.md

# Builder — project guide

A marketplace of n8n-backed "agents" and workflows. **Next.js 16 (App Router) +
Prisma 7 (driver adapter `@prisma/adapter-pg`) + PostgreSQL.** n8n owns execution;
this app owns everything that is displayed or entered by a person. Read
`README.md` for the product, `docs/knowledge-search.md` for the RAG system.

## Commands

| | |
|---|---|
| `npm run dev` | dev server (needs Postgres; `npm run db:up` starts one with Docker) |
| `npm run build` | production build |
| `npm run typecheck` · `npm run lint` | `tsc --noEmit` · eslint |
| `npm run test:db:setup` (once) · `npm test` | create + migrate the `<db>_test` database · run the suite (real Postgres, files run serially) |
| `npm run migrate` | **apply pending migrations** (`prisma migrate deploy`) — what production runs |
| `npm run db:migrate` | `prisma migrate dev`: create a new migration from schema changes (local only) |
| `npm run worker` · `npm run reindex` | knowledge indexing worker · re-queue stale files |

## Rules that have bitten us

- **Any change to `prisma/schema.prisma` needs a migration** in `prisma/migrations/`
  (additive; never edit one that has been applied anywhere). Before relying on a
  deploy, run `npm run migrate` against a scratch database and confirm it succeeds,
  starting from the *previous* migration state. A schema ahead of the database
  breaks every request with Prisma `P2022` ("column … does not exist") — the app
  loads, then every screen after sign-in fails.
- Never run `prisma db push`, `prisma migrate reset` or anything destructive
  against a shared or production database. Production database work is dry-run
  first and confirmed by the owner.
- `prisma` (the CLI) is a **runtime dependency**, pinned to the same exact
  version as `@prisma/client` and `@prisma/adapter-pg`. Bump the three together.
  The Docker image installs the CLI in a separate `migrate-tools` stage so that
  `npm run migrate` works inside it; do not rely on `npx prisma` fetching one.
- pgvector is optional at migration time: the embedding column is added in a
  `DO $$ … $$` block that tolerates a database without the extension. Keep it that
  way, or a deploy onto such a database fails.
- **Never build an absolute URL from `request.url`.** Behind Railway's proxy the
  server reports its own listening address (`https://0.0.0.0:8080`), so a redirect
  built from it strands the browser. Use `appUrl()` / `publicOrigin()` from
  `src/lib/public-origin.ts` (PUBLIC_URL, else the forwarded host, else the request).
- Secrets never go in code, commits, logs or chat: `DATABASE_URL`, `AUTH_SECRET`,
  `SECRETS_KEY`, Google/Gemini keys, the `kb_…` installation keys.

## Deployment

Railway, project **worthy-bravery**, service **marketplace**, built from the
`Dockerfile`. **Pre-deploy command: `npm run migrate`.** Environment variables are
documented in `.env.example` / `.env.production.example`; they are set in Railway,
not in the repository. Indexing needs a clock: set `KNOWLEDGE_TICK_INTERVAL_SECONDS=60`
(built-in scheduler, `src/instrumentation.ts`), or run a worker service, or call
`POST /api/knowledge/tick` every minute (header `x-schedule-token`). Also call
`POST /api/accounts/keepalive` daily.

## gstack (REQUIRED — global install)

**Before doing ANY work, verify gstack is installed:**

```bash
_GS=""
for _D in "${GSTACK_ROOT:-}" "$HOME/.claude/skills/gstack" "$HOME/.codex/skills/gstack" "$HOME/.factory/skills/gstack" "$HOME/.kiro/skills/gstack" "$HOME/.config/opencode/skills/gstack" "$HOME/.slate/skills/gstack" "$HOME/.cursor/skills/gstack" "$HOME/.openclaw/skills/gstack" "$HOME/.hermes/skills/gstack" "$HOME/.gbrain/skills/gstack" "$HOME/.copilot/skills/gstack" "$HOME/.gstack/repos/gstack"; do
  [ -z "$_GS" ] && [ -n "$_D" ] && [ -d "$_D/bin" ] && _GS="$_D"
done
[ -n "$_GS" ] && echo "GSTACK_OK: $_GS" || echo "GSTACK_MISSING"
```

If GSTACK_MISSING: STOP. Do not proceed. Tell the user:

> gstack is required for all AI-assisted work in this repo.
> Install it:
> ```bash
> git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
> cd ~/.claude/skills/gstack && ./setup --team
> ```
> Then restart your AI coding tool.

Do not skip skills, ignore gstack errors, or work around missing gstack.

Using gstack skills: After install, skills like /qa, /ship, /review, /investigate,
and /browse are available. Use /browse for all web browsing (Aside first, the bundled gstack browser as fallback).
Use the resolved install path above for gstack file paths
(default: ~/.claude/skills/gstack).
