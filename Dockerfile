# Builder — production image.
#
#   docker build -t builder .
#   docker run --rm -p 3000:3000 --env-file .env.production builder
#
# Three stages, so the thing that ships carries none of what built it. The final
# image has no compiler, no Prisma CLI, no test runner and no source: just Node,
# the traced output of `next build`, and the generated Prisma client.
#
# Nothing is baked in. Every secret arrives as an environment variable at run
# time — see lib/env.ts, which refuses to start on a missing or example one. A
# build argument would be worse than useless here: it is recorded in the image's
# own history, where anyone who can pull the image can read it back.

# ------------------------------------------------------------------ deps
# Separated from the build so a change to src/ does not reinstall node_modules.
FROM node:22-alpine AS deps
WORKDIR /app

# postinstall runs `prisma generate`, which needs the schema — so both come in
# before the install rather than with the rest of the source.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# ----------------------------------------------------------------- build
FROM node:22-alpine AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `next build` sets NODE_ENV=production itself and then imports every route to
# collect page data. lib/env.ts exempts that phase, so the build needs no real
# secrets — but it does need the variables to parse, and DATABASE_URL is read at
# module scope. This value is never connected to: nothing in a build talks to a
# database, and the running container is given its own.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ------------------------------------------------------------------- run
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Not root. A remote-code bug in a dependency is a much smaller event when the
# process that hits it cannot write to the image it is running from.
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nextjs -G nodejs

# standalone carries server.js and the traced subset of node_modules. static/
# and public/ are not traced — they are served, not imported — so they are
# copied in beside it, which is what makes server.js serve them.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

# `next build` copies the project's .env into .next/standalone, and server.js
# loads it — so a .env in the build context would arrive here as a file that
# overrides the environment the container is actually given, with a developer's
# AUTH_SECRET and SECRETS_KEY in it. .dockerignore already keeps it out of the
# context, which makes that line load-bearing rather than housekeeping; this is
# the second lock, for the day someone tidies the first one away.
RUN rm -f .env .env.local .env.production .env.production.local

USER nextjs
EXPOSE 3000

# The endpoint runs `SELECT 1`, so an instance that cannot reach Postgres is
# reported unhealthy rather than restarted-and-still-broken. start-period is
# generous because the first request compiles nothing but does open the pool.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations are deliberately not run here. Two instances starting at once would
# race, and a rollback would leave the schema ahead of the code. `prisma migrate
# deploy` belongs in the release step that precedes the new containers — the
# README's deployment section says so at greater length.
CMD ["node", "server.js"]
