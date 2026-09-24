import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The session cookie.
 *
 * readSession() is the single place a user id enters the system: every call
 * into n8n takes the id from here, and every ownership check is only as good as
 * this function refusing a token it should not accept. So the cases below are
 * mostly about what it rejects.
 *
 * next/headers only works inside a request, so the cookie jar is replaced with
 * a plain Map that behaves like one.
 */

type Cookie = { name: string; value: string; options?: Record<string, unknown> };

const jar = vi.hoisted(() => ({ store: new Map<string, Cookie>() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => jar.store.get(name),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      jar.store.set(name, { name, value, options });
    },
    delete: (name: string) => {
      jar.store.delete(name);
    },
  }),
}));

const { createSession, destroySession, readSession } = await import("@/lib/session");

const COOKIE = "builder_session";
const read = () => jar.store.get(COOKIE);

beforeEach(() => jar.store.clear());
afterEach(() => vi.useRealTimers());

describe("createSession", () => {
  it("round-trips the user id", async () => {
    await createSession("user-123");
    await expect(readSession()).resolves.toEqual({ userId: "user-123" });
  });

  it("is httpOnly, so script on the page cannot read it", async () => {
    await createSession("user-123");
    expect(read()!.options).toMatchObject({ httpOnly: true });
  });

  it("is sameSite lax, so another site cannot post with it", async () => {
    await createSession("user-123");
    expect(read()!.options).toMatchObject({ sameSite: "lax" });
  });

  it("is scoped to the whole site and expires", async () => {
    await createSession("user-123");
    expect(read()!.options).toMatchObject({ path: "/", maxAge: 60 * 60 * 24 * 7 });
  });

  it("does not put the user id in the cookie in readable form", async () => {
    // It is a signed JWT, so the id is base64 in the payload rather than
    // secret — but it must at least not be sitting there as plain text.
    await createSession("user-123");
    expect(read()!.value).not.toContain("user-123");
    expect(read()!.value.split(".")).toHaveLength(3);
  });
});

describe("destroySession", () => {
  it("removes the cookie", async () => {
    await createSession("user-123");
    await destroySession();

    expect(read()).toBeUndefined();
    await expect(readSession()).resolves.toBeNull();
  });
});

describe("readSession refuses", () => {
  it("no cookie at all", async () => {
    await expect(readSession()).resolves.toBeNull();
  });

  it("a cookie that is not a token", async () => {
    jar.store.set(COOKIE, { name: COOKIE, value: "not-a-jwt" });
    await expect(readSession()).resolves.toBeNull();
  });

  it("an empty cookie", async () => {
    jar.store.set(COOKIE, { name: COOKIE, value: "" });
    await expect(readSession()).resolves.toBeNull();
  });

  it("a token whose payload was edited", async () => {
    // The whole point of signing it: swapping the id must not let the holder
    // become another user.
    await createSession("user-123");
    const [header, , signature] = read()!.value.split(".");
    const forged = Buffer.from(
      JSON.stringify({ userId: "someone-else", iat: 1, exp: 9_999_999_999 }),
    ).toString("base64url");

    jar.store.set(COOKIE, { name: COOKIE, value: [header, forged, signature].join(".") });
    await expect(readSession()).resolves.toBeNull();
  });

  it("a token signed with a different key", async () => {
    const { SignJWT } = await import("jose");
    const wrongKey = new TextEncoder().encode("a-different-secret-entirely");
    const token = await new SignJWT({ userId: "user-123" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("7d")
      .sign(wrongKey);

    jar.store.set(COOKIE, { name: COOKIE, value: token });
    await expect(readSession()).resolves.toBeNull();
  });

  it("an unsigned token, however well-formed", async () => {
    // "alg": "none" is the classic JWT bypass; jwtVerify is pinned to HS256.
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ userId: "user-123", exp: 9_999_999_999 }),
    ).toString("base64url");

    jar.store.set(COOKIE, { name: COOKIE, value: `${header}.${payload}.` });
    await expect(readSession()).resolves.toBeNull();
  });

  it("an expired token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    await createSession("user-123");

    // A week and a day later.
    vi.setSystemTime(new Date("2026-01-09T00:00:00Z"));
    await expect(readSession()).resolves.toBeNull();
  });

  it("a valid token with no user id in it", async () => {
    const { SignJWT } = await import("jose");
    const key = new TextEncoder().encode(process.env.AUTH_SECRET);
    const token = await new SignJWT({ somethingElse: true })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("7d")
      .sign(key);

    jar.store.set(COOKIE, { name: COOKIE, value: token });
    await expect(readSession()).resolves.toBeNull();
  });

  it("a token whose user id is not a string", async () => {
    const { SignJWT } = await import("jose");
    const key = new TextEncoder().encode(process.env.AUTH_SECRET);
    const token = await new SignJWT({ userId: { toString: "nope" } })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("7d")
      .sign(key);

    jar.store.set(COOKIE, { name: COOKIE, value: token });
    await expect(readSession()).resolves.toBeNull();
  });
});

describe("a token still inside its week", () => {
  it("is accepted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    await createSession("user-123");

    vi.setSystemTime(new Date("2026-01-06T00:00:00Z"));
    await expect(readSession()).resolves.toEqual({ userId: "user-123" });
  });
});
