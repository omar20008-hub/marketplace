import "server-only";

/**
 * A fixed-window limiter, in memory.
 *
 * It exists because the sign-in form had nothing in front of it: a script could
 * work through a password list as fast as bcrypt would answer, and the only
 * trace would be a quiet row of failures nobody reads.
 *
 * Be clear about what this is. The counters live in one process, so they are
 * lost on restart and are not shared between instances — behind two servers an
 * attacker gets two budgets. That is a real weakness and the reason the store
 * is behind an interface: moving the three calls below to Redis or Postgres is
 * the whole of the upgrade. What it does buy, today, is that the cheap attack
 * from one machine stops being cheap, and it costs nothing to run.
 *
 * It fails closed on nothing: an unknown key is simply allowed, because a
 * limiter that locks people out when it loses its memory is worse than the
 * attack it prevents.
 */

type Window = { count: number; resetAt: number };

// On the global so Next's dev server, which re-evaluates modules on every edit,
// does not hand out a fresh empty map with each keystroke.
const globalForLimiter = globalThis as unknown as {
  __rateLimiter?: Map<string, Window>;
};
const windows = (globalForLimiter.__rateLimiter ??= new Map<string, Window>());

export type RateLimitResult = {
  ok: boolean;
  /** Attempts left in this window, never below zero. */
  remaining: number;
  /** Seconds until the window resets. Zero when the attempt was allowed. */
  retryAfterSeconds: number;
};

/**
 * Counts one attempt against `key`, and says whether it may proceed.
 *
 * Sweeps expired windows as it goes, so the map cannot grow without bound from
 * keys nobody uses again — which, for a key derived from an email address, is
 * most of them.
 */
export function hit(
  key: string,
  { limit, windowMs, now = Date.now() }: { limit: number; windowMs: number; now?: number },
): RateLimitResult {
  for (const [existing, window] of windows) {
    if (window.resetAt <= now) windows.delete(existing);
  }

  const current = windows.get(key);

  if (!current || current.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  current.count += 1;

  if (current.count > limit) {
    return {
      ok: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }

  return { ok: true, remaining: limit - current.count, retryAfterSeconds: 0 };
}

/**
 * Forgets a key. Called after a successful sign-in, so someone who mistyped
 * their password twice and then got it right is not still near the limit.
 */
export function clear(key: string) {
  windows.delete(key);
}

/** Only for tests, which must not inherit counters from each other. */
export function resetAll() {
  windows.clear();
}
