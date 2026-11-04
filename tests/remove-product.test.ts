import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Removing a product from the admin screen. The product goes only when nothing
 * depends on it, and only when the admin types its slug.
 */

const viewer = vi.hoisted(() => ({
  current: null as { id: string; roles: string[] } | null,
}));

class Redirected extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}

vi.mock("@/lib/auth", () => ({
  requireRole: async (role: string) => {
    if (!viewer.current) throw new Redirected("/login");
    if (!viewer.current.roles.includes(role)) throw new Redirected("/");
    return viewer.current;
  },
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirected(to);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { prisma } = await import("@/lib/db");
const { removeProduct } = await import("@/server/admin-actions");

const PLAN_ID = "remove-product-plan";

async function wipe() {
  await prisma.auditLog.deleteMany({});
  await prisma.installation.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

async function setup() {
  await prisma.plan.upsert({
    where: { id: PLAN_ID },
    update: {},
    create: { id: PLAN_ID, name: "Test", monthlyRuns: 100, storageBytes: BigInt(1_000_000), monthlyCredits: 0 },
  });
  const admin = await prisma.user.create({
    data: { email: `admin-${Math.random()}@test.local`, name: "A", passwordHash: "x", initials: "A", planId: PLAN_ID },
  });
  const slug = `broken-${Math.random().toString(36).slice(2, 8)}`;
  const product = await prisma.product.create({
    data: {
      slug,
      creatorId: admin.id,
      title: "Chat with your sheet 08",
      summary: "s",
      description: "d",
      needsFromYou: "n",
      kind: "WORKFLOW",
      category: "Reporting",
      inputSchema: [] as never,
    },
  });
  return { admin, product };
}

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

async function refusedTo(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Redirected) return error.to;
    throw error;
  }
  throw new Error("expected a redirect");
}

beforeEach(async () => {
  await wipe();
  viewer.current = null;
});
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("removeProduct", () => {
  it("refuses a person who is not an admin", async () => {
    const { admin, product } = await setup();
    viewer.current = { id: admin.id, roles: [] };
    const to = await refusedTo(removeProduct(form({ productId: product.id, confirm: product.slug })));
    expect(to).toBe("/");
    expect(await prisma.product.findUnique({ where: { id: product.id } })).not.toBeNull();
  });

  it("removes nothing unless the slug is typed exactly", async () => {
    const { admin, product } = await setup();
    viewer.current = { id: admin.id, roles: ["ADMIN"] };
    const to = await refusedTo(removeProduct(form({ productId: product.id, confirm: "wrong" })));
    expect(to).toContain("error=confirm");
    expect(await prisma.product.findUnique({ where: { id: product.id } })).not.toBeNull();
  });

  it("removes an unused product and records who did it", async () => {
    const { admin, product } = await setup();
    viewer.current = { id: admin.id, roles: ["ADMIN"] };
    const to = await refusedTo(removeProduct(form({ productId: product.id, confirm: product.slug })));
    expect(to).toContain("saved=");
    expect(await prisma.product.findUnique({ where: { id: product.id } })).toBeNull();
    const entry = await prisma.auditLog.findFirst({ where: { action: "product.removed" } });
    expect(entry?.subject).toBe(`product:${product.slug}`);
    expect(entry?.actorId).toBe(admin.id);
  });

  it("refuses a product that someone has installed, and removes nothing", async () => {
    const { admin, product } = await setup();
    const person = await prisma.user.create({
      data: { email: `person-${Math.random()}@test.local`, name: "P", passwordHash: "x", initials: "P", planId: PLAN_ID },
    });
    await prisma.installation.create({
      data: {
        installationId: `inst-${Math.random()}`,
        userId: person.id,
        productId: product.id,
        pinnedVersion: "1.0",
        storageBackend: "platform",
        status: "ACTIVE",
      },
    });
    viewer.current = { id: admin.id, roles: ["ADMIN"] };
    const to = await refusedTo(removeProduct(form({ productId: product.id, confirm: product.slug })));
    expect(to).toContain("error=in_use");
    expect(to).toContain("installs=1");
    expect(await prisma.product.findUnique({ where: { id: product.id } })).not.toBeNull();
  });
});
