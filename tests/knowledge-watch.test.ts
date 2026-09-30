import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Drive push notifications: channel lifecycle, the webhook that receives them,
 * and deciding from the change feed whether a notification matters. Google is a
 * stubbed fetch; the database is real.
 */

vi.mock("@/server/google-account", () => ({
  getGoogleAccessToken: vi.fn(async () => "token"),
  saveGoogleConnection: vi.fn(),
}));

const { prisma } = await import("@/lib/db");
const { GOOGLE_DRIVE_CREDENTIAL } = await import("@/lib/google-oauth");
const { ensureWatch, renewWatches, stopWatch, webhookAddress } = await import(
  "@/server/knowledge/watch"
);
const { processChanges, touchesSource } = await import("@/server/knowledge/changes");
const { POST: webhook } = await import("@/app/api/knowledge/drive-webhook/route");

type Call = { url: string; method: string; body: Record<string, unknown> | null };
let calls: Call[] = [];
let feed: { status?: number; body?: unknown } = {};

function stubGoogle() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      const reply = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (url.includes("/changes/startPageToken")) return reply({ startPageToken: "100" });
      if (url.includes("/changes/watch")) {
        const body = JSON.parse(String(init!.body));
        return reply({ resourceId: `res-${body.id.slice(0, 4)}`, expiration: body.expiration });
      }
      if (url.includes("/channels/stop")) return reply({});
      if (url.includes("/drive/v3/changes?")) return reply(feed.body ?? {}, feed.status ?? 200);
      return reply({}, 404);
    }),
  );
}

let sourceId = "";
const { seedInstallation } = await import("./knowledge-fixtures");
const PLAN_ID = "test-plan-watch";

async function wipe() {
  await prisma.knowledgeJob.deleteMany({});
  await prisma.knowledgeChunk.deleteMany({});
  await prisma.knowledgeFile.deleteMany({});
  await prisma.knowledgeSource.deleteMany({});
  await prisma.installation.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.connectedAccount.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

beforeEach(async () => {
  await wipe();
  calls = [];
  feed = {};
  stubGoogle();
  await prisma.plan.create({
    data: { id: PLAN_ID, name: "T", monthlyRuns: 1, storageBytes: BigInt(1), monthlyCredits: 0 },
  });
  const user = await prisma.user.create({
    data: { email: "w@example.test", name: "W", passwordHash: "x", initials: "W", planId: PLAN_ID },
  });
  const account = await prisma.connectedAccount.create({
    data: {
      userId: user.id,
      credentialType: GOOGLE_DRIVE_CREDENTIAL,
      displayName: "Google Drive",
      initials: "GD",
      accountRef: "w@example.test",
      status: "ACTIVE",
    },
  });
  const source = await prisma.knowledgeSource.create({
    data: {
      userId: user.id,
      installationId: (await seedInstallation(user.id)).id,
      accountId: account.id,
      folderId: "root",
      folderName: "Root",
      folderIds: ["root", "sub"],
    },
  });
  sourceId = source.id;
});

afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

const load = () => prisma.knowledgeSource.findUniqueOrThrow({ where: { id: sourceId } });
const jobs = () => prisma.knowledgeJob.findMany();

describe("webhookAddress", () => {
  it("is the app's own https origin", () => {
    expect(webhookAddress()).toBe("https://app.example.test/api/knowledge/drive-webhook");
  });
});

describe("ensureWatch", () => {
  it("takes a cursor and opens a channel that calls our webhook with a secret", async () => {
    await ensureWatch(sourceId, "token");
    const source = await load();
    expect(source.changesToken).toBe("100");
    expect(source.channelId).toBeTruthy();
    expect(source.channelToken).toHaveLength(48);
    expect(source.channelExpiry!.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);

    const watch = calls.find((c) => c.url.includes("/changes/watch"))!;
    expect(watch.body).toMatchObject({
      id: source.channelId,
      type: "web_hook",
      address: "https://app.example.test/api/knowledge/drive-webhook",
      token: source.channelToken,
    });
    expect(watch.url).toContain("pageToken=100");
  });

  it("leaves a healthy channel alone", async () => {
    await ensureWatch(sourceId, "token");
    calls = [];
    await ensureWatch(sourceId, "token");
    expect(calls).toHaveLength(0);
  });

  it("replaces a channel close to expiry and stops the old one", async () => {
    await ensureWatch(sourceId, "token");
    const first = await load();
    await prisma.knowledgeSource.update({
      where: { id: sourceId },
      data: { channelExpiry: new Date(Date.now() + 60_000) },
    });
    calls = [];
    await ensureWatch(sourceId, "token");
    const second = await load();
    expect(second.channelId).not.toBe(first.channelId);
    expect(second.channelExpiry!.getTime()).toBeGreaterThan(Date.now() + 86_400_000);
    const stop = calls.find((c) => c.url.includes("/channels/stop"))!;
    expect(stop.body).toEqual({ id: first.channelId, resourceId: first.channelResourceId });
  });

  it("keeps the new channel even if stopping the old one fails", async () => {
    await ensureWatch(sourceId, "token");
    const first = await load();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/channels/stop")) return new Response("{}", { status: 500 });
        const body = JSON.parse(String(init!.body));
        return new Response(JSON.stringify({ resourceId: "r2", expiration: body.expiration }), { status: 200 });
      }),
    );
    await ensureWatch(sourceId, "token", { force: true });
    expect((await load()).channelId).not.toBe(first.channelId);
  });

  it("uses the expiry Google actually grants", async () => {
    const granted = String(Date.now() + 2 * 3_600_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) =>
        String(input).includes("startPageToken")
          ? new Response(JSON.stringify({ startPageToken: "1" }), { status: 200 })
          : new Response(JSON.stringify({ resourceId: "r", expiration: granted }), { status: 200 }),
      ),
    );
    await ensureWatch(sourceId, "token");
    expect((await load()).channelExpiry!.getTime()).toBe(Number(granted));
  });
});

describe("renewWatches and stopWatch", () => {
  it("opens a channel for a source that has none and skips a healthy one", async () => {
    const summary = await renewWatches({ force: true });
    expect(summary.renewed).toBe(1);
    expect((await load()).channelId).toBeTruthy();
    calls = [];
    expect((await renewWatches({ force: true })).renewed).toBe(0);
  });

  it("forgets the channel when a source stops being watched", async () => {
    await ensureWatch(sourceId, "token");
    await stopWatch(sourceId);
    expect(await load()).toMatchObject({ channelId: null, channelToken: null, channelExpiry: null });
    expect(calls.some((c) => c.url.includes("/channels/stop"))).toBe(true);
  });
});

describe("touchesSource", () => {
  const folders = new Set(["root", "sub"]);
  const known = new Set(["file1"]);
  it("matches a known file, a tree folder, or anything filed in the tree", () => {
    expect(touchesSource({ fileId: "file1", parents: [] }, known, folders)).toBe(true);
    expect(touchesSource({ fileId: "sub", parents: [] }, known, folders)).toBe(true);
    expect(touchesSource({ fileId: "new", parents: ["sub"] }, known, folders)).toBe(true);
  });
  it("ignores the rest of the drive", () => {
    expect(touchesSource({ fileId: "other", parents: ["elsewhere"] }, known, folders)).toBe(false);
  });
});

describe("processChanges", () => {
  beforeEach(() => prisma.knowledgeSource.update({ where: { id: sourceId }, data: { changesToken: "100" } }));

  it("queues a sync when something in the folder changed, and moves the cursor", async () => {
    feed = { body: { changes: [{ fileId: "new", file: { parents: ["sub"] } }], newStartPageToken: "105" } };
    await processChanges(sourceId);
    expect((await jobs()).map((j) => j.kind)).toEqual(["SYNC_SOURCE"]);
    expect((await load()).changesToken).toBe("105");
  });

  it("notices a deletion of a file it knows, which carries no parents", async () => {
    await prisma.knowledgeFile.create({
      data: { sourceId, externalId: "gone", name: "g", mimeType: "text/plain", revision: "r" },
    });
    feed = { body: { changes: [{ fileId: "gone", removed: true }], newStartPageToken: "106" } };
    await processChanges(sourceId);
    expect(await jobs()).toHaveLength(1);
  });

  it("does nothing for changes elsewhere in the drive, but still advances", async () => {
    feed = { body: { changes: [{ fileId: "x", file: { parents: ["elsewhere"] } }], newStartPageToken: "107" } };
    await processChanges(sourceId);
    expect(await jobs()).toHaveLength(0);
    expect((await load()).changesToken).toBe("107");
  });

  it("follows pagination to the end of the feed", async () => {
    let page = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        page++;
        const body =
          page === 1
            ? { changes: [], nextPageToken: "p2" }
            : { changes: [{ fileId: "n", file: { parents: ["root"] } }], newStartPageToken: "200" };
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    await processChanges(sourceId);
    expect(page).toBe(2);
    expect(await jobs()).toHaveLength(1);
  });

  it("starts over from a full sync when Drive rejects the cursor", async () => {
    feed = { status: 410, body: {} };
    await processChanges(sourceId);
    expect((await load()).changesToken).toBeNull();
    expect((await jobs()).map((j) => j.kind)).toEqual(["SYNC_SOURCE"]);
  });

  it("takes a cursor and syncs when there is none", async () => {
    await prisma.knowledgeSource.update({ where: { id: sourceId }, data: { changesToken: null } });
    await processChanges(sourceId);
    expect((await load()).changesToken).toBe("100");
    expect((await jobs()).map((j) => j.kind)).toEqual(["SYNC_SOURCE"]);
  });

  it("lets a transient Drive error surface for retry, leaving the cursor where it was", async () => {
    feed = { status: 503, body: {} };
    await expect(processChanges(sourceId)).rejects.toThrow();
    expect((await load()).changesToken).toBe("100");
  });
});

describe("drive webhook", () => {
  const hit = (headers: Record<string, string>) =>
    webhook(new Request("https://app.example.test/api/knowledge/drive-webhook", { method: "POST", headers }));

  beforeEach(() => ensureWatch(sourceId, "token"));

  it("queues a debounced changes read for a genuine notification", async () => {
    const s = await load();
    const res = await hit({
      "x-goog-channel-id": s.channelId!,
      "x-goog-channel-token": s.channelToken!,
      "x-goog-resource-state": "change",
    });
    expect(res.status).toBe(200);
    const [job] = await jobs();
    expect(job.kind).toBe("SYNC_CHANGES");
    expect(job.runAfter.getTime()).toBeGreaterThan(Date.now() + 2000);
  });

  it("collapses a burst of notifications into one job", async () => {
    const s = await load();
    const headers = {
      "x-goog-channel-id": s.channelId!,
      "x-goog-channel-token": s.channelToken!,
      "x-goog-resource-state": "update",
    };
    await hit(headers);
    await hit(headers);
    await hit(headers);
    expect(await jobs()).toHaveLength(1);
  });

  it("does nothing for the initial sync message", async () => {
    const s = await load();
    await hit({
      "x-goog-channel-id": s.channelId!,
      "x-goog-channel-token": s.channelToken!,
      "x-goog-resource-state": "sync",
    });
    expect(await jobs()).toHaveLength(0);
  });

  it("refuses a wrong token and queues nothing", async () => {
    const s = await load();
    const res = await hit({
      "x-goog-channel-id": s.channelId!,
      "x-goog-channel-token": "nope",
      "x-goog-resource-state": "change",
    });
    expect(res.status).toBe(401);
    expect(await jobs()).toHaveLength(0);
  });

  it("answers an unknown channel with a quiet 200, and a missing id with 400", async () => {
    const unknown = await hit({ "x-goog-channel-id": "old-channel", "x-goog-channel-token": "x", "x-goog-resource-state": "change" });
    expect(unknown.status).toBe(200);
    expect(await jobs()).toHaveLength(0);
    expect((await hit({})).status).toBe(400);
  });
});
