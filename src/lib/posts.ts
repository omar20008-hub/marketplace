/** A tick runs about once a minute; this long past due, something is not running it. */
const OVERDUE_MS = 5 * 60_000;

type Timed = { status: string; scheduledAt: Date };

/**
 * What the Posts screen needs to know about the clock. Kept out of the page so the
 * page stays free of `Date.now()`, and so the two thresholds are testable.
 *
 *  - `stalled`: a post is well past its time and still not published — the thing
 *    that runs the tick is probably not running.
 *  - `busy`: a post is publishing or about to be, so the page should refresh itself.
 */
export function postsActivity(posts: Timed[], now = Date.now()) {
  const waiting = posts.filter((post) => post.status === "SCHEDULED");
  return {
    stalled: waiting.some((post) => now - post.scheduledAt.getTime() > OVERDUE_MS),
    busy:
      posts.some((post) => post.status === "PUBLISHING") ||
      waiting.some((post) => post.scheduledAt.getTime() - now < 60_000),
  };
}
