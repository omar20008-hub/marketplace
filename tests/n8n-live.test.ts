import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The live driver, with fetch stubbed.
 *
 * The case that matters most is the first one. Three workflows still use a Form
 * Trigger and answer with an HTML page; live.ts refuses that reply rather than
 * half-parsing it, and the error text is what tells whoever converts the
 * triggers what to do. These tests are the contract that conversion has to
 * satisfy, so the switch to N8N_DRIVER=live is a configuration change and not a
 * debugging session.
 */

const BASE = "https://n8n.example.test/api/v1";
const UPLOAD = "https://n8n.example.test/webhook/upload";
const DISPATCH = "https://n8n.example.test/webhook/dispatch";
const STORAGE = "https://n8n.example.test/webhook/storage";

/**
 * env is built once at import, so each test imports the driver fresh after
 * setting the variables it needs.
 */
async function loadDriver(overrides: Record<string, string> = {}) {
  vi.resetModules();
  vi.stubEnv("N8N_DRIVER", "live");
  vi.stubEnv("N8N_BASE_URL", BASE);
  vi.stubEnv("N8N_API_KEY", "test-api-key");
  vi.stubEnv("N8N_WEBHOOK_TOKEN", "test-webhook-token");
  vi.stubEnv("N8N_UPLOAD_WEBHOOK_URL", UPLOAD);
  vi.stubEnv("N8N_DISPATCH_WEBHOOK_URL", DISPATCH);
  vi.stubEnv("N8N_STORAGE_WEBHOOK_URL", STORAGE);
  vi.stubEnv("N8N_DISPATCHER_WORKFLOW_ID", "disp1");
  for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);

  return (await import("@/lib/n8n/live")).liveDriver;
}

function reply(
  body: string,
  { status = 200, contentType = "application/json" } = {},
) {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

const uploadInput = {
  creatorId: "c1",
  title: "T",
  description: "D",
  actionType: "read" as const,
  file: "{}",
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("a workflow still on a Form Trigger", () => {
  it("is refused, and the error says what to change", async () => {
    fetchMock.mockResolvedValue(
      reply("<!DOCTYPE html><html><body>Form submitted</body></html>", {
        contentType: "text/html; charset=utf-8",
      }),
    );
    const driver = await loadDriver();

    await expect(driver.upload(uploadInput)).rejects.toThrow(/Webhook Trigger/);
  });

  it("is refused even when the HTML page comes back with a 200", async () => {
    // The trap this avoids: an HTML success page parsed as a failed upload, or
    // worse, silently treated as an accepted one.
    fetchMock.mockResolvedValue(
      reply("<html>ok</html>", { contentType: "text/html" }),
    );
    const driver = await loadDriver();

    await expect(driver.upload(uploadInput)).rejects.toThrow(/Form Trigger/);
  });
});

describe("postWebhook", () => {
  it("refuses to call an unconfigured URL", async () => {
    const driver = await loadDriver({ N8N_UPLOAD_WEBHOOK_URL: "" });

    await expect(driver.upload(uploadInput)).rejects.toThrow(
      /Webhook URL is not configured/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the shared secret as x-platform-token", async () => {
    fetchMock.mockResolvedValue(
      reply(JSON.stringify({ ok: false, errorText: "no" })),
    );
    const driver = await loadDriver();
    await driver.upload(uploadInput);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(UPLOAD);
    expect(init.method).toBe("POST");
    expect(init.headers["x-platform-token"]).toBe("test-webhook-token");
    expect(JSON.parse(init.body)).toMatchObject({ creatorId: "c1" });
  });

  it("omits the header entirely when no token is set, rather than sending an empty one", async () => {
    fetchMock.mockResolvedValue(
      reply(JSON.stringify({ ok: false, errorText: "no" })),
    );
    const driver = await loadDriver({ N8N_WEBHOOK_TOKEN: "" });
    await driver.upload(uploadInput);

    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty(
      "x-platform-token",
    );
  });

  it("reports the status when n8n rejects the call", async () => {
    fetchMock.mockResolvedValue(reply("nope", { status: 401 }));
    const driver = await loadDriver();

    await expect(driver.upload(uploadInput)).rejects.toThrow(/n8n replied 401/);
  });

  it("reports a reply that is not JSON", async () => {
    fetchMock.mockResolvedValue(reply("not json at all"));
    const driver = await loadDriver();

    await expect(driver.upload(uploadInput)).rejects.toThrow(/was not JSON/);
  });

  it("parses an accepted upload", async () => {
    fetchMock.mockResolvedValue(
      reply(
        JSON.stringify({
          templateId: "tpl_9",
          status: "in_review",
          nodeCount: 4,
          credentialDurability: "durable",
        }),
      ),
    );
    const driver = await loadDriver();

    // The comma-separated list fields default rather than failing the parse.
    expect(await driver.upload(uploadInput)).toEqual({
      templateId: "tpl_9",
      status: "in_review",
      nodeCount: 4,
      credentialDurability: "durable",
      flaggedNodes: "",
      requiredCredentials: "",
      externalHosts: "",
    });
  });

  it("refuses a JSON reply that does not match the contract", async () => {
    // A workflow edited into returning something else should fail here, not
    // reach a screen as a half-populated product.
    fetchMock.mockResolvedValue(
      reply(JSON.stringify({ templateId: "tpl_9", status: "published" })),
    );
    const driver = await loadDriver();

    await expect(driver.upload(uploadInput)).rejects.toThrow();
  });
});

describe("dispatch and storage go over a webhook too", () => {
  it("posts a dispatch to its webhook and parses the result contract", async () => {
    fetchMock.mockResolvedValue(
      reply(JSON.stringify({ result: "success", toolOutput: "{}" })),
    );
    const driver = await loadDriver();

    const out = await driver.dispatch({
      userId: "u1",
      installationId: "i1",
      args: { a: 1 },
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(DISPATCH);
    expect(init.method).toBe("POST");
    expect(init.headers["x-platform-token"]).toBe("test-webhook-token");
    expect(JSON.parse(init.body)).toMatchObject({ userId: "u1" });
    expect(out).toEqual({ result: "success", toolOutput: "{}" });
  });

  it("posts storage to its webhook", async () => {
    fetchMock.mockResolvedValue(
      reply(JSON.stringify({ ok: true, deleted: 1 })),
    );
    const driver = await loadDriver();

    await driver.storage({ installationId: "i1", operation: "delete", path: "a.txt" });

    expect(fetchMock.mock.calls[0][0]).toBe(STORAGE);
  });

  it("never sends the API key anywhere a webhook is called", async () => {
    // The key controls every workflow and credential on the instance, so no
    // user-facing path may carry it. Since dispatch and storage moved to
    // webhooks, that is now every path a user can take.
    fetchMock.mockResolvedValue(
      reply(JSON.stringify({ result: "denied", reason: "no" })),
    );
    const driver = await loadDriver();

    await driver.dispatch({ userId: "u1", installationId: "i1", args: {} });
    await driver.upload(uploadInput).catch(() => undefined);

    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers).not.toHaveProperty("X-N8N-API-KEY");
    }
  });

  it("refuses an unconfigured dispatch URL rather than calling nothing", async () => {
    const driver = await loadDriver({ N8N_DISPATCH_WEBHOOK_URL: "" });

    await expect(
      driver.dispatch({ userId: "u1", installationId: "i1", args: {} }),
    ).rejects.toThrow(/Webhook URL is not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a failed dispatch by status", async () => {
    fetchMock.mockResolvedValue(reply("boom", { status: 500 }));
    const driver = await loadDriver();

    await expect(
      driver.dispatch({ userId: "u1", installationId: "i1", args: {} }),
    ).rejects.toThrow(/n8n replied 500/);
  });

  it("refuses an HTML reply from the dispatcher as well", async () => {
    fetchMock.mockResolvedValue(
      reply("<html>ok</html>", { contentType: "text/html" }),
    );
    const driver = await loadDriver();

    await expect(
      driver.dispatch({ userId: "u1", installationId: "i1", args: {} }),
    ).rejects.toThrow(/Webhook Trigger/);
  });
});

describe("listTemplates", () => {
  it("returns an empty list rather than undefined when the table is empty", async () => {
    fetchMock.mockResolvedValue(reply(JSON.stringify({})));
    const driver = await loadDriver();

    expect(await driver.listTemplates()).toEqual([]);
  });
});

describe("credentialSchema", () => {
  it("degrades to null when the instance has no schema for the type", async () => {
    fetchMock.mockResolvedValue(reply("nope", { status: 404 }));
    const driver = await loadDriver();

    expect(await driver.credentialSchema("nonesuch")).toBeNull();
  });
});
