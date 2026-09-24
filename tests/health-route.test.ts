import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * The health endpoint.
 *
 * What is worth pinning down is the failure, not the success: an orchestrator
 * acts on this answer, so a probe that returns 200 while the database is
 * unreachable sends traffic to an instance that cannot serve it, and one that
 * returns 503 for the wrong reason restarts instances that were fine.
 */

const { GET } = await import("@/app/api/health/route");
const { prisma } = await import("@/lib/db");

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.$disconnect();
});

describe("GET /api/health", () => {
  it("answers 200 when the database answers", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      database: "reachable",
    });
  });

  it("reports how long the query took", async () => {
    const body = await (await GET()).json();

    expect(typeof body.latencyMs).toBe("number");
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("answers 503 when the database does not", async () => {
    // 503 rather than 500: the instance is up and saying it cannot serve, which
    // is the distinction a load balancer acts on.
    const query = vi
      .spyOn(prisma, "$queryRaw")
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:5432"));

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      database: "unreachable",
    });
    query.mockRestore();
  });

  it("says what went wrong without attaching a stack", async () => {
    // Enough to tell a refused connection from a wrong password in a deploy
    // log; not enough to hand a stranger paths and versions.
    const query = vi
      .spyOn(prisma, "$queryRaw")
      .mockRejectedValueOnce(new Error("password authentication failed"));

    const body = await (await GET()).json();

    expect(body.detail).toBe("password authentication failed");
    expect(JSON.stringify(body)).not.toMatch(/\bat \/|node_modules|\.ts:\d+/);
    query.mockRestore();
  });

  it("does not throw when something that is not an Error is thrown", async () => {
    const query = vi.spyOn(prisma, "$queryRaw").mockRejectedValueOnce("nope");

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      detail: "unknown error",
    });
    query.mockRestore();
  });
});
