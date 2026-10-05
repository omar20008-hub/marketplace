import { NextResponse } from "next/server";
import { EmbeddingError } from "@/lib/embeddings";
import { hit } from "@/lib/rate-limit";
import { knowledgeAvailable } from "@/server/knowledge/availability";
import { installationForKey } from "@/server/knowledge/keys";
import { searchKnowledge } from "@/server/knowledge/search";

/**
 * Knowledge search, called by an installed workflow — not by a browser. It is
 * authenticated by the installation's own key (see keys.ts), and what it can
 * search is fixed by that key: the sources attached to that installation.
 */

const MAX_QUERY_CHARS = 2000;

export async function POST(request: Request) {
  const installation = await installationForKey(request.headers.get("authorization"));
  if (!installation) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limiter = hit(`knowledge-search:${installation.id}`, { limit: 60, windowMs: 60_000 });
  if (!limiter.ok) {
    return NextResponse.json(
      { error: "Too many searches" },
      { status: 429, headers: { "retry-after": String(limiter.retryAfterSeconds) } },
    );
  }

  let body: { query?: unknown; limit?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query || query.length > MAX_QUERY_CHARS) {
    return NextResponse.json(
      { error: `query is required and at most ${MAX_QUERY_CHARS} characters` },
      { status: 400 },
    );
  }

  if (!(await knowledgeAvailable())) {
    return NextResponse.json({ error: "Knowledge search is not available" }, { status: 503 });
  }

  try {
    const result = await searchKnowledge(
      installation.id,
      query,
      typeof body.limit === "number" ? body.limit : undefined,
    );
    return NextResponse.json(result);
  } catch (error) {
    // The embedding service is rate-limited or down: say so briefly rather than
    // holding the caller (a person is waiting) or failing with a bare 500.
    if (error instanceof EmbeddingError && error.retryable) {
      return NextResponse.json(
        { error: "Search is busy, try again in a minute" },
        { status: 503, headers: { "retry-after": String(error.limit?.retryAfterSeconds ?? 30) } },
      );
    }
    throw error;
  }
}

export const dynamic = "force-dynamic";
