import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/**
 * Whether this instance can actually serve a request.
 *
 * A container orchestrator restarts what fails this and sends traffic to what
 * passes it, so the answer has to mean something. Returning a bare 200 from the
 * web process would say only that Node is running — which is the one thing that
 * is almost never the problem. Every screen in the platform reads the database
 * on the way to rendering, so an instance that cannot reach Postgres is not
 * healthy in any sense a load balancer should act on, however well it answers.
 *
 * Hence the query. `SELECT 1` is the cheapest statement that proves a
 * connection was taken from the pool, sent, and answered — it touches no table,
 * takes no lock, and returns before anything else could make it slow.
 *
 * It deliberately does not check n8n. n8n being down stops runs, and the
 * readiness badges say so on screen; it does not stop this instance serving the
 * catalogue, the sign-in form or someone's history. Restarting the platform
 * would not fix it either, so failing the probe on it would turn one outage
 * into a restart loop on top of an outage.
 *
 * No token. What it discloses is whether a database is reachable, which anyone
 * can infer from whether the site loads, and a probe that needs a secret is one
 * more thing to get wrong in the place where getting it wrong takes the
 * deployment down.
 */

export async function GET() {
  const started = Date.now();

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    // The message, not the stack: this reply is public, and a stack names
    // paths and versions. Enough to tell a wrong password from a refused
    // connection in a deploy log, and no more.
    return NextResponse.json(
      {
        ok: false,
        database: "unreachable",
        detail: error instanceof Error ? error.message : "unknown error",
      },
      { status: 503 },
    );
  }

  return NextResponse.json({
    ok: true,
    database: "reachable",
    latencyMs: Date.now() - started,
  });
}

/**
 * Never cached, and never prerendered. A health check answered from a cache is
 * a health check of the cache.
 */
export const dynamic = "force-dynamic";
