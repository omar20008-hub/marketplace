import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Signing in and out.
 *
 * The behaviour worth pinning down is the one that is easy to undo by
 * accident: the form says the same thing whether or not an address has an
 * account, so it cannot be used to find out who is registered.
 */

type Cookie = { name: string; value: string };
const jar = vi.hoisted(() => ({ store: new Map<string, Cookie>() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => jar.store.get(name),
    set: (name: string, value: string) => jar.store.set(name, { name, value }),
    delete: (name: string) => jar.store.delete(name),
  }),
}));

class Redirected extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirected(to);
  },
}));

const { prisma } = await import("@/lib/db");
const { hashPassword } = await import("@/lib/auth");
const { readSession } = await import("@/lib/session");
const { login, logout } = await import("@/server/auth-actions");

const PLAN_ID = "test-plan-auth-actions";
const COOKIE = "builder_session";

async function wipe() {
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

async function makeUser(email: string) {
  await prisma.plan.upsert({
    where: { id: PLAN_ID },
    create: {
      id: PLAN_ID,
      name: "Test",
      monthlyRuns: 10,
      storageBytes: BigInt(1000),
      monthlyCredits: 0,
    },
    update: {},
  });
  return prisma.user.create({
    data: {
      email,
      name: "Tester",
      passwordHash: await hashPassword("builder"),
      initials: "TE",
      planId: PLAN_ID,
    },
  });
}

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

/** Runs login and reports either the redirect or the message it refused with. */
async function attempt(values: Record<string, string>) {
  try {
    const state = await login({}, form(values));
    return { to: null as string | null, error: state.error };
  } catch (error) {
    if (error instanceof Redirected) return { to: error.to, error: undefined };
    throw error;
  }
}

beforeEach(async () => {
  jar.store.clear();
  await wipe();
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("login", () => {
  it("signs a user in and starts a session", async () => {
    const user = await makeUser("nora@acme.co");

    const result = await attempt({ email: "nora@acme.co", password: "builder" });

    expect(result.to).toBe("/");
    await expect(readSession()).resolves.toEqual({ userId: user.id });
  });

  it("ignores case and surrounding space in the address", async () => {
    const user = await makeUser("nora@acme.co");

    const result = await attempt({ email: "  NORA@Acme.CO  ", password: "builder" });

    expect(result.to).toBe("/");
    await expect(readSession()).resolves.toEqual({ userId: user.id });
  });

  it("does not ignore case in the password", async () => {
    await makeUser("nora@acme.co");
    const result = await attempt({ email: "nora@acme.co", password: "Builder" });

    expect(result.to).toBeNull();
    expect(jar.store.get(COOKIE)).toBeUndefined();
  });

  it("says the same thing for an unknown address as for a wrong password", async () => {
    // Otherwise the form is a way to find out who has an account here.
    await makeUser("nora@acme.co");

    const wrongPassword = await attempt({
      email: "nora@acme.co",
      password: "not-it",
    });
    const noSuchUser = await attempt({
      email: "nobody@example.test",
      password: "not-it",
    });

    expect(wrongPassword.error).toBe("That email and password do not match.");
    expect(noSuchUser.error).toBe(wrongPassword.error);
  });

  it("starts no session when it refuses", async () => {
    await makeUser("nora@acme.co");
    await attempt({ email: "nora@acme.co", password: "not-it" });

    expect(jar.store.get(COOKIE)).toBeUndefined();
    await expect(readSession()).resolves.toBeNull();
  });

  it.each([
    [{ email: "", password: "builder" }],
    [{ email: "nora@acme.co", password: "" }],
    [{}],
  ])("asks for both fields when one is missing: %o", async (values) => {
    const result = await attempt(values as Record<string, string>);
    expect(result.error).toBe("Enter an email and a password.");
  });

  it("does not take an empty password as a match for an empty hash", async () => {
    // A user row with no usable hash must not be signed into by sending "".
    await prisma.plan.upsert({
      where: { id: PLAN_ID },
      create: {
        id: PLAN_ID,
        name: "Test",
        monthlyRuns: 10,
        storageBytes: BigInt(1000),
        monthlyCredits: 0,
      },
      update: {},
    });
    await prisma.user.create({
      data: {
        email: "empty@example.test",
        name: "Empty",
        passwordHash: "",
        initials: "EM",
        planId: PLAN_ID,
      },
    });

    const result = await attempt({ email: "empty@example.test", password: "" });
    expect(result.to).toBeNull();
    expect(jar.store.get(COOKIE)).toBeUndefined();
  });
});

describe("logout", () => {
  it("clears the session and sends them to sign-in", async () => {
    const user = await makeUser("nora@acme.co");
    await attempt({ email: "nora@acme.co", password: "builder" });
    await expect(readSession()).resolves.toEqual({ userId: user.id });

    let destination: string | null = null;
    try {
      await logout();
    } catch (error) {
      if (error instanceof Redirected) destination = error.to;
      else throw error;
    }

    expect(destination).toBe("/login");
    await expect(readSession()).resolves.toBeNull();
  });
});
