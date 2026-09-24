import { beforeEach, describe, expect, it } from "vitest";
import { clear, hit, resetAll } from "@/lib/rate-limit";

/**
 * The limiter in front of the sign-in form. The cases that matter are the
 * boundaries: the attempt that is still allowed, the one that is not, and what
 * happens when the window rolls over.
 */

const opts = { limit: 3, windowMs: 60_000 };

beforeEach(resetAll);

describe("hit", () => {
  it("allows up to the limit and refuses the one after", () => {
    const now = 1_000_000;

    expect(hit("a", { ...opts, now })).toMatchObject({ ok: true, remaining: 2 });
    expect(hit("a", { ...opts, now })).toMatchObject({ ok: true, remaining: 1 });
    expect(hit("a", { ...opts, now })).toMatchObject({ ok: true, remaining: 0 });

    const refused = hit("a", { ...opts, now });
    expect(refused.ok).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfterSeconds).toBe(60);
  });

  it("counts each key separately", () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) hit("a", { ...opts, now });

    expect(hit("a", { ...opts, now }).ok).toBe(false);
    expect(hit("b", { ...opts, now }).ok).toBe(true);
  });

  it("starts a fresh window once the old one passes", () => {
    const now = 1_000_000;
    for (let i = 0; i < 4; i++) hit("a", { ...opts, now });
    expect(hit("a", { ...opts, now }).ok).toBe(false);

    expect(hit("a", { ...opts, now: now + 60_001 })).toMatchObject({
      ok: true,
      remaining: 2,
    });
  });

  it("keeps refusing until the window actually ends", () => {
    const now = 1_000_000;
    for (let i = 0; i < 4; i++) hit("a", { ...opts, now });

    // One millisecond early is still inside the window.
    expect(hit("a", { ...opts, now: now + 59_999 }).ok).toBe(false);
  });

  it("counts down the wait as the window runs out", () => {
    const now = 1_000_000;
    for (let i = 0; i < 4; i++) hit("a", { ...opts, now });

    expect(hit("a", { ...opts, now: now + 30_000 }).retryAfterSeconds).toBe(30);
    expect(hit("a", { ...opts, now: now + 59_500 }).retryAfterSeconds).toBe(1);
  });

  it("forgets keys whose window has passed, so the map cannot grow forever", () => {
    const now = 1_000_000;
    for (let i = 0; i < 500; i++) hit(`key-${i}`, { ...opts, now });

    // A later call sweeps the expired ones; the survivor is the new key.
    expect(hit("fresh", { ...opts, now: now + 60_001 })).toMatchObject({ ok: true });
    // The old key is gone, so it starts over rather than being still counted.
    expect(hit("key-0", { ...opts, now: now + 60_001 })).toMatchObject({
      ok: true,
      remaining: 2,
    });
  });
});

describe("clear", () => {
  it("puts a key back to a full budget", () => {
    const now = 1_000_000;
    hit("a", { ...opts, now });
    hit("a", { ...opts, now });

    clear("a");

    expect(hit("a", { ...opts, now })).toMatchObject({ ok: true, remaining: 2 });
  });

  it("does nothing for a key that was never counted", () => {
    expect(() => clear("never-seen")).not.toThrow();
  });
});
