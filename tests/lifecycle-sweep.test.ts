import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { n8n } from "@/lib/n8n";
import { liveDriver } from "@/lib/n8n/live";
import { runLifecycleSweep } from "@/server/lifecycle-sweep";
import { POST } from "@/app/api/lifecycle/sweep/route";

/**
 * The daily lifecycle sweep against the platform's own installations. The n8n
 * dispatcher is spied on so the cases can say whether a copy was switched off there.
 */

const PLAN_ID = "test-plan";

async function wipe() {
  await prisma.installation.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

async function makeUser(email: string) {
  await prisma.plan.upsert({
    where: { id: PLAN_ID },
    update: {},
    create: {
      id: PLAN_ID,
      name: "Test",
      monthlyRuns: 100,
      storageBytes: BigInt(1_000_000),
      monthlyCredits: 0,
    },
  });
  return prisma.user.create({
    data: { email, name: "Tester", passwordHash: "x", initials: "TE", planId: PLAN_ID },
  });
}

async function install(
  userId: string,
  productStatus: "PUBLISHED" | "SECURITY_HOLD" | "DELETED",
  extra: { status?: "ACTIVE" | "DISABLED" | "PARTIAL"; failureCount?: number; instanceWorkflowId?: string | null } = {},
) {
  const product = await prisma.product.create({
    data: {
      slug: `p-${Math.random().toString(36).slice(2, 10)}`,
      creatorId: userId,
      title: "Weekly Digest",
      summary: "s",
      description: "d",
      needsFromYou: "n",
      kind: "WORKFLOW",
      category: "Reporting",
      actionType: "READ",
      status: productStatus,
    },
  });
  return prisma.installation.create({
    data: {
      userId,
      productId: product.id,
      pinnedVersion: "1.0",
      status: extra.status ?? "ACTIVE",
      failureCount: extra.failureCount ?? 0,
      instanceWorkflowId: extra.instanceWorkflowId === undefined ? "wf_copy" : extra.instanceWorkflowId,
    },
  });
}

beforeEach(wipe);
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("runLifecycleSweep", () => {
  it("switches off a copy whose product is on security hold, in n8n and here", async () => {
    const user = await makeUser("sweep-hold@example.test");
    const copy = await install(user.id, "SECURITY_HOLD");
    const deactivate = vi.spyOn(n8n, "deactivateInstance");

    const result = await runLifecycleSweep();

    expect(deactivate).toHaveBeenCalledWith("wf_copy");
    expect(result.disabled).toEqual([copy.id]);
    const after = await prisma.installation.findUniqueOrThrow({ where: { id: copy.id } });
    expect(after.status).toBe("DISABLED");
    expect(after.attentionNote).toBe("إيقاف أمني للقالب");
  });

  it("switches off a copy whose product was deleted", async () => {
    const user = await makeUser("sweep-deleted@example.test");
    const copy = await install(user.id, "DELETED");

    await runLifecycleSweep();

    const after = await prisma.installation.findUniqueOrThrow({ where: { id: copy.id } });
    expect(after.status).toBe("DISABLED");
    expect(after.attentionNote).toBe("حُذف القالب");
  });

  it("leaves a copy of a published product alone", async () => {
    const user = await makeUser("sweep-published@example.test");
    const copy = await install(user.id, "PUBLISHED");
    const deactivate = vi.spyOn(n8n, "deactivateInstance");

    const result = await runLifecycleSweep();

    expect(deactivate).not.toHaveBeenCalled();
    expect(result.disabled).toEqual([]);
    expect((await prisma.installation.findUniqueOrThrow({ where: { id: copy.id } })).status).toBe("ACTIVE");
  });

  it("lists, but does not change, a copy disabled after five failures in a row", async () => {
    const user = await makeUser("sweep-failures@example.test");
    const copy = await install(user.id, "PUBLISHED", { status: "DISABLED", failureCount: 5 });
    const deactivate = vi.spyOn(n8n, "deactivateInstance");

    const result = await runLifecycleSweep();

    expect(result.reported).toEqual([copy.id]);
    expect(deactivate).not.toHaveBeenCalled();
    expect((await prisma.installation.findUniqueOrThrow({ where: { id: copy.id } })).status).toBe("DISABLED");
  });

  it("still marks the copy disabled when n8n refuses to deactivate it, and says so", async () => {
    const user = await makeUser("sweep-refused@example.test");
    const copy = await install(user.id, "SECURITY_HOLD");
    vi.spyOn(n8n, "deactivateInstance").mockResolvedValue({ ok: false });

    const result = await runLifecycleSweep();

    expect(result.n8nRefused).toEqual([copy.id]);
    expect((await prisma.installation.findUniqueOrThrow({ where: { id: copy.id } })).status).toBe("DISABLED");
  });

  it("disables without calling n8n when the copy was never created there", async () => {
    const user = await makeUser("sweep-partial@example.test");
    const copy = await install(user.id, "SECURITY_HOLD", { status: "ACTIVE", instanceWorkflowId: null });
    const deactivate = vi.spyOn(n8n, "deactivateInstance");

    await runLifecycleSweep();

    expect(deactivate).not.toHaveBeenCalled();
    expect((await prisma.installation.findUniqueOrThrow({ where: { id: copy.id } })).status).toBe("DISABLED");
  });

  it("ignores copies that are still being installed", async () => {
    const user = await makeUser("sweep-partial-status@example.test");
    await install(user.id, "SECURITY_HOLD", { status: "PARTIAL" });

    const result = await runLifecycleSweep();

    expect(result.checked).toBe(0);
  });
});

describe("the live n8n deactivation", () => {
  it("posts to the workflow's deactivate endpoint with the API key, and reports a refusal", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchImpl);

    try {
      const result = await liveDriver.deactivateInstance("wf 1");

      expect(result).toEqual({ ok: false });
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(url.endsWith("/workflows/wf%201/deactivate")).toBe(true);
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>)["X-N8N-API-KEY"]).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports ok when n8n deactivates the copy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    try {
      expect(await liveDriver.deactivateInstance("wf_copy")).toEqual({ ok: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the sweep route", () => {
  it("refuses a request without the schedule token", async () => {
    const response = await POST(
      new Request("http://localhost/api/lifecycle/sweep", { method: "POST" }),
    );
    expect(response.status).toBe(401);
  });

  it("runs the sweep and returns counts when the token is right", async () => {
    const response = await POST(
      new Request("http://localhost/api/lifecycle/sweep", {
        method: "POST",
        headers: { "x-schedule-token": "test-schedule-token" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, checked: 0, disabled: 0, reported: 0, n8nRefused: 0 });
  });
});
