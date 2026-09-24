import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { POST } from "@/app/api/n8n/sync/route";

/**
 * The inbound mirror update, called by MP · Publish Sync.
 *
 * Two things make this worth testing at least as much as the tick. It writes to
 * the catalogue with no session anywhere in the request, so the token is the
 * only thing in front of it — anyone who found the URL could publish their own
 * product or withdraw someone else's. And it is a *partial* update by design:
 * the handover records a bug found in testing where a transient n8n outage read
 * as a mass delete, so a template the sync does not mention must be left alone.
 * That rule is invisible in the code — it is the absence of a delete — which is
 * exactly the kind of rule that gets refactored away.
 *
 * tests/setup.ts sets N8N_SYNC_TOKEN.
 */

const TOKEN = process.env.N8N_SYNC_TOKEN;
const PLAN_ID = "test-plan-sync";
const CREATOR_ID = "test-creator-sync";

type Row = {
  templateId: string;
  status: string;
  n8nWorkflowId?: string;
  requiredCredentials?: string;
  externalHosts?: string;
  flaggedNodes?: string;
  credentialDurability?: string;
  rejectionReason?: string;
};

function call(body: unknown, headers: Record<string, string> = { "x-sync-token": TOKEN! }) {
  return new Request("http://localhost/api/n8n/sync", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const sync = (rows: Row[]) => POST(call({ rows }));

async function wipe() {
  await prisma.product.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

async function makeProduct(
  templateId: string,
  overrides: Partial<{ status: string; slug: string }> = {},
) {
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
  await prisma.user.upsert({
    where: { id: CREATOR_ID },
    create: {
      id: CREATOR_ID,
      email: "creator@sync.test",
      name: "Creator",
      passwordHash: "x",
      initials: "CR",
      planId: PLAN_ID,
    },
    update: {},
  });

  return prisma.product.create({
    data: {
      slug: overrides.slug ?? templateId,
      templateId,
      creatorId: CREATOR_ID,
      title: "A product",
      summary: "one line",
      description: "what it does",
      needsFromYou: "nothing",
      kind: "WORKFLOW",
      category: "Sales",
      status: (overrides.status ?? "IN_REVIEW") as never,
    },
  });
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("the token", () => {
  it("is required", async () => {
    const response = await POST(
      call({ rows: [] }, { "content-type": "application/json" }),
    );
    expect(response.status).toBe(401);
  });

  it("must match", async () => {
    const response = await POST(call({ rows: [] }, { "x-sync-token": "not-it" }));
    expect(response.status).toBe(401);
  });

  it("refuses before reading the body, so a bad payload cannot be probed", async () => {
    // Otherwise the 400/401 difference tells a stranger their guess parsed.
    const response = await POST(call("{ not json", { "x-sync-token": "not-it" }));
    expect(response.status).toBe(401);
  });

  it("is checked before anything is written", async () => {
    const product = await makeProduct("tpl_1");

    await POST(call({ rows: [{ templateId: "tpl_1", status: "published" }] }, {}));

    const after = await prisma.product.findUnique({ where: { id: product.id } });
    expect(after?.status).toBe("IN_REVIEW");
  });
});

describe("the payload", () => {
  it("refuses a body that is not JSON", async () => {
    expect((await POST(call("{ not json"))).status).toBe(400);
  });

  it("refuses a status the platform has no column for", async () => {
    const response = await sync([{ templateId: "tpl_1", status: "banana" }]);
    expect(response.status).toBe(400);
  });

  it("refuses rows that are missing a template id", async () => {
    const response = await POST(call({ rows: [{ status: "published" }] }));
    expect(response.status).toBe(400);
  });

  it("takes an empty list without touching anything", async () => {
    const product = await makeProduct("tpl_1");
    const response = await sync([]);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ updated: 0, unknown: 0 });
    const after = await prisma.product.findUnique({ where: { id: product.id } });
    expect(after?.status).toBe("IN_REVIEW");
  });
});

describe("what it writes", () => {
  it("moves a product to the status n8n reports", async () => {
    const product = await makeProduct("tpl_1");

    const body = await (await sync([{ templateId: "tpl_1", status: "published" }])).json();

    expect(body).toMatchObject({ ok: true, updated: 1, unknown: 0 });
    const after = await prisma.product.findUnique({ where: { id: product.id } });
    expect(after?.status).toBe("PUBLISHED");
  });

  it("stamps publishedAt the first time, and not again", async () => {
    await makeProduct("tpl_1");

    await sync([{ templateId: "tpl_1", status: "published" }]);
    const first = await prisma.product.findUnique({ where: { templateId: "tpl_1" } });

    await sync([{ templateId: "tpl_1", status: "published" }]);
    const second = await prisma.product.findUnique({ where: { templateId: "tpl_1" } });

    expect(first?.publishedAt).not.toBeNull();
    // A re-sync must not make an old product look new on the marketplace.
    expect(second?.publishedAt?.getTime()).toBe(first?.publishedAt?.getTime());
  });

  it("splits the list fields rather than storing one string", async () => {
    await makeProduct("tpl_1");

    await sync([
      {
        templateId: "tpl_1",
        status: "published",
        requiredCredentials: "gmailOAuth2,slackApi",
        externalHosts: "api.example.com, hooks.example.com",
      },
    ]);

    const after = await prisma.product.findUnique({ where: { templateId: "tpl_1" } });
    expect(after?.requiredCredentials).toEqual(["gmailOAuth2", "slackApi"]);
    expect(after?.externalHosts).toEqual(["api.example.com", "hooks.example.com"]);
  });

  it("leaves a field alone when the row omits it", async () => {
    // A sync that reports only a status must not blank everything else.
    await makeProduct("tpl_1");
    await sync([
      { templateId: "tpl_1", status: "in_review", requiredCredentials: "gmailOAuth2" },
    ]);

    await sync([{ templateId: "tpl_1", status: "published" }]);

    const after = await prisma.product.findUnique({ where: { templateId: "tpl_1" } });
    expect(after?.requiredCredentials).toEqual(["gmailOAuth2"]);
  });
});

describe("what it refuses to write", () => {
  it("reports a template it has never seen instead of inventing a product", async () => {
    const body = await (await sync([{ templateId: "tpl_unknown", status: "published" }])).json();

    expect(body).toMatchObject({ updated: 0, unknown: 1 });
    expect(await prisma.product.count()).toBe(0);
  });

  it.each(["RESTRICTED", "SUSPENDED"])(
    "does not undo a platform-side %s",
    async (status) => {
      // These are decisions an admin made here; the workflow's enum has no
      // equivalent, so a sync reporting "published" must not lift them.
      const product = await makeProduct("tpl_1", { status });

      const body = await (await sync([{ templateId: "tpl_1", status: "published" }])).json();

      const after = await prisma.product.findUnique({ where: { id: product.id } });
      expect(after?.status).toBe(status);
      expect(body.updated).toBe(0);
    },
  );

  it("leaves a product the sync does not mention completely alone", async () => {
    // The bug the handover records: a transient n8n outage returning a short
    // list must not read as "everything else is gone".
    await makeProduct("tpl_1", { status: "PUBLISHED", slug: "one" });
    await makeProduct("tpl_2", { status: "PUBLISHED", slug: "two" });

    await sync([{ templateId: "tpl_1", status: "withdrawn" }]);

    const untouched = await prisma.product.findUnique({ where: { templateId: "tpl_2" } });
    expect(untouched?.status).toBe("PUBLISHED");
    expect(await prisma.product.count()).toBe(2);
  });

  it("keeps going after a row it cannot place", async () => {
    await makeProduct("tpl_1");

    const body = await (
      await sync([
        { templateId: "tpl_unknown", status: "published" },
        { templateId: "tpl_1", status: "published" },
      ])
    ).json();

    expect(body).toMatchObject({ updated: 1, unknown: 1 });
    const after = await prisma.product.findUnique({ where: { templateId: "tpl_1" } });
    expect(after?.status).toBe("PUBLISHED");
  });
});
