# Project rules for the autonomous pipeline

Read by every agent in the headless pipeline. These rules are specific to this repository.
The gstack requirement in the root `CLAUDE.md` does NOT apply to a pipeline run. gstack is
not installed in CI, so do not stop because it is missing.

## Project

Builder: a marketplace of n8n-backed agents and workflows. Next.js 16 (App Router),
Prisma 7 with the `@prisma/adapter-pg` driver, and PostgreSQL (pgvector optional).
n8n runs executions; this app shows and collects what people enter.
`docs/knowledge-search.md` describes the RAG system.

## Commands (Node 22)

- Install: `npm ci` (postinstall runs `prisma generate`)
- Type-check: `npm run typecheck`
- Lint: `npm run lint`
- Unit tests: `npm test` (vitest against a real Postgres; the test database already exists in CI)
- Build: `npm run build`. Slow. Run it only if the change touches routes, config or server components.
- End-to-end (Playwright) is not part of the gate. Do not run it.

## Structure

- `src/`: Next.js app. Routes under `src/app`, shared server code under `src/lib`.
- `src/**/*.test.ts` and `tests/**/*.test.ts`: unit tests. `tests/setup.ts` sets the test environment.
- `prisma/schema.prisma` and `prisma/migrations/`: database schema and migrations.
- `scripts/`: worker, reindex and scheduler entry points.

## Conventions

- Every new behaviour needs a test. Never skip, disable or loosen an existing test.
- A change to `prisma/schema.prisma` needs a new additive migration folder under
  `prisma/migrations/`, written as SQL. Never edit a migration that already exists.
  Keep the embedding column in its `DO $$ ... $$` block so the migration still works without pgvector.
- Never build an absolute URL from `request.url`. Use `appUrl()` or `publicOrigin()` from `src/lib/public-origin.ts`.
- Never use `prisma db push`, `prisma migrate reset`, or `npm run migrate` (it deploys to whatever
  `DATABASE_URL` points at).
- No new dependencies unless the task requires one. Justify any addition in the summary.
- Secrets never go in code, tests or logs: `DATABASE_URL`, `AUTH_SECRET`, `SECRETS_KEY`, API keys.

## Never touch

- `.github/`, `.claude/`, `CLAUDE.md`, `AGENTS.md`
- `.env*`, credentials, `Dockerfile`, `docker-compose.yml`, deployment configuration
- Migrations that already exist in `prisma/migrations/`
- Generated code: `src/generated/`
