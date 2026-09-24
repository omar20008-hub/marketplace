import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Passwords, and the three gates every screen goes through.
 *
 * requireUser() and requireRole() decide who sees what; each returns by
 * throwing a redirect, so next/navigation is replaced with one that throws
 * something the tests can read the destination off.
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
const { createSession } = await import("@/lib/session");
const {
  currentUser,
  hashPassword,
  has,
  requireRole,
  requireUser,
  verifyPassword,
} = await import("@/lib/auth");

const PLAN_ID = "test-plan-auth";

async function wipe() {
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

async function makeUser(roles: ("USER" | "ADMIN" | "CREATOR")[] = ["USER"]) {
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
      email: `u${Math.random().toString(36).slice(2, 8)}@example.test`,
      name: "Tester",
      passwordHash: await hashPassword("builder"),
      initials: "TE",
      planId: PLAN_ID,
      roles,
    },
  });
}

/** Runs something that redirects, and reports where it went. */
async function destinationOf(run: () => Promise<unknown>) {
  try {
    await run();
    return null;
  } catch (error) {
    if (error instanceof Redirected) return error.to;
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

describe("hashPassword and verifyPassword", () => {
  it("accepts the right password", async () => {
    const hash = await hashPassword("correct horse");
    await expect(verifyPassword("correct horse", hash)).resolves.toBe(true);
  });

  it("rejects the wrong one", async () => {
    const hash = await hashPassword("correct horse");
    await expect(verifyPassword("Correct horse", hash)).resolves.toBe(false);
    await expect(verifyPassword("", hash)).resolves.toBe(false);
    await expect(verifyPassword("correct horse ", hash)).resolves.toBe(false);
  });

  it("never stores the password itself", async () => {
    const hash = await hashPassword("hunter2");
    expect(hash).not.toContain("hunter2");
  });

  it("salts, so two users with the same password do not share a hash", async () => {
    const [a, b] = await Promise.all([
      hashPassword("same password"),
      hashPassword("same password"),
    ]);

    expect(a).not.toBe(b);
    await expect(verifyPassword("same password", a)).resolves.toBe(true);
    await expect(verifyPassword("same password", b)).resolves.toBe(true);
  });

  it("rejects a hash that is not one, rather than throwing", async () => {
    await expect(verifyPassword("anything", "not-a-hash")).resolves.toBe(false);
  });
});

describe("currentUser", () => {
  it("is null with no session", async () => {
    await expect(currentUser()).resolves.toBeNull();
  });

  it("returns the signed-in user, with their plan", async () => {
    const user = await makeUser();
    await createSession(user.id);

    const viewer = await currentUser();
    expect(viewer).toMatchObject({ id: user.id, email: user.email });
    // executeRun() reads the run allowance straight off this.
    expect(viewer!.plan).toMatchObject({ id: PLAN_ID, monthlyRuns: 10 });
  });

  it("is null when the session names a user who no longer exists", async () => {
    const user = await makeUser();
    await createSession(user.id);
    await prisma.user.delete({ where: { id: user.id } });

    await expect(currentUser()).resolves.toBeNull();
  });
});

describe("requireUser", () => {
  it("returns the viewer when there is one", async () => {
    const user = await makeUser();
    await createSession(user.id);

    await expect(requireUser()).resolves.toMatchObject({ id: user.id });
  });

  it("sends a stranger to the sign-in page", async () => {
    expect(await destinationOf(requireUser)).toBe("/login");
  });

  it("sends someone holding a forged cookie to the sign-in page", async () => {
    jar.store.set("builder_session", {
      name: "builder_session",
      value: "not.a.token",
    });

    expect(await destinationOf(requireUser)).toBe("/login");
  });
});

describe("requireRole", () => {
  it("lets the role through", async () => {
    const admin = await makeUser(["USER", "ADMIN"]);
    await createSession(admin.id);

    await expect(requireRole("ADMIN")).resolves.toMatchObject({ id: admin.id });
  });

  it("sends a signed-in user without the role home, not to sign-in", async () => {
    // They are signed in; the answer is "not for you", not "who are you".
    const user = await makeUser(["USER"]);
    await createSession(user.id);

    expect(await destinationOf(() => requireRole("ADMIN"))).toBe("/");
  });

  it("sends a stranger to the sign-in page", async () => {
    expect(await destinationOf(() => requireRole("ADMIN"))).toBe("/login");
  });

  it("does not let one role stand in for another", async () => {
    const creator = await makeUser(["USER", "CREATOR"]);
    await createSession(creator.id);

    expect(await destinationOf(() => requireRole("ADMIN"))).toBe("/");
    await expect(requireRole("CREATOR")).resolves.toMatchObject({ id: creator.id });
  });
});

describe("has", () => {
  it("reads a role off a viewer", () => {
    expect(has({ roles: ["USER", "ADMIN"] }, "ADMIN")).toBe(true);
    expect(has({ roles: ["USER"] }, "ADMIN")).toBe(false);
  });

  it("is false for nobody, rather than throwing", () => {
    expect(has(null, "ADMIN")).toBe(false);
  });
});
