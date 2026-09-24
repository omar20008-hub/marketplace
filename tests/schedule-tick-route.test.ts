import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { GET, POST } from "@/app/api/schedules/tick/route";

/**
 * The heartbeat endpoint.
 *
 * It runs other people's workflows and spends their plan limits, with no
 * session anywhere in the request, so the token check is the only thing
 * standing in front of it. tests/setup.ts sets SCHEDULE_TOKEN.
 */

const TOKEN = process.env.SCHEDULE_TOKEN;

function call(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/schedules/tick", {
    method: "POST",
    headers,
  });
}

async function wipe() {
  await prisma.artifact.deleteMany({});
  await prisma.runStep.deleteMany({});
  await prisma.run.deleteMany({});
  await prisma.schedule.deleteMany({});
  await prisma.installation.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("the token", () => {
  it("is required", async () => {
    const response = await POST(call());
    expect(response.status).toBe(401);
  });

  it("must match", async () => {
    const response = await POST(call({ "x-schedule-token": "not-the-token" }));
    expect(response.status).toBe(401);
  });

  it("is not satisfied by an empty header", async () => {
    const response = await POST(call({ "x-schedule-token": "" }));
    expect(response.status).toBe(401);
  });

  it("lets a correct token through", async () => {
    const response = await POST(call({ "x-schedule-token": TOKEN! }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      checked: 0,
      ran: 0,
    });
  });
});

describe("GET", () => {
  it("does the same thing, for a scheduler that can only issue one", async () => {
    expect(GET).toBe(POST);
    const response = await GET(call({ "x-schedule-token": TOKEN! }));
    expect(response.status).toBe(200);
  });
});
