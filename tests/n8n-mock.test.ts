import { describe, expect, it } from "vitest";
import { contentHash, mockDriver } from "@/lib/n8n/mock";

/**
 * The README claims the mock "is not a stub that always says yes — it enforces
 * the same rules the real workflows do". That claim is only worth anything if
 * each rule is pinned down, because a screen is only trustworthy against the
 * real instance to the extent the mock refuses what the instance refuses.
 *
 * One test per rule named in the README.
 */

const trigger = {
  type: "n8n-nodes-base.executeWorkflowTrigger",
  parameters: {
    inputSource: "workflowInputs",
    workflowInputs: { values: [{ name: "sheetUrl" }] },
  },
};

const workflow = (...nodes: unknown[]) =>
  JSON.stringify({ nodes: [trigger, ...nodes] });

/** A complete UploadInput, so only the file under test varies. */
const upload = (file: string) => ({
  creatorId: "c1",
  title: "Weekly Digest",
  description: "Sends a digest every Monday.",
  actionType: "read" as const,
  file,
});

describe("upload — the structural condition", () => {
  it("refuses a file that is not JSON", async () => {
    const reply = await mockDriver.upload(upload("not json"));
    expect(reply).toEqual({ ok: false, errorText: "The file is not valid JSON." });
  });

  it("refuses a workflow with no nodes", async () => {
    const reply = await mockDriver.upload(upload(JSON.stringify({ nodes: [] })));
    expect(reply).toMatchObject({ ok: false });
  });

  it("refuses a workflow that does not start with an Execute Workflow Trigger", async () => {
    const reply = await mockDriver.upload(
      upload(JSON.stringify({ nodes: [{ type: "n8n-nodes-base.webhook" }] })),
    );

    expect(reply).toMatchObject({ ok: false });
    expect("errorText" in reply && reply.errorText).toContain(
      "When Executed by Another Workflow",
    );
  });

  it("refuses a trigger whose fields are not declared explicitly", async () => {
    const reply = await mockDriver.upload(
      upload(
        JSON.stringify({
          nodes: [
            {
              type: "n8n-nodes-base.executeWorkflowTrigger",
              parameters: { inputSource: "passthrough" },
            },
          ],
        }),
      ),
    );

    expect("errorText" in reply && reply.errorText).toContain("workflowInputs");
  });

  it("accepts a well-formed workflow", async () => {
    const reply = await mockDriver.upload(upload(workflow()));

    expect(reply).toMatchObject({ status: "in_review", nodeCount: 1 });
    expect("templateId" in reply && reply.templateId).toMatch(/^tpl_/);
  });
});

describe("upload — the node allow-list", () => {
  it.each([
    "n8n-nodes-base.executeCommand",
    "n8n-nodes-base.ssh",
    "n8n-nodes-base.readWriteFile",
  ])("rejects %s by name", async (type) => {
    const reply = await mockDriver.upload(upload(workflow({ type })));

    expect(reply).toMatchObject({ ok: false });
    expect("errorText" in reply && reply.errorText).toContain(type);
  });

  it("names every forbidden node once, not once per occurrence", async () => {
    const reply = await mockDriver.upload(
      upload(
        workflow({ type: "n8n-nodes-base.ssh" }, { type: "n8n-nodes-base.ssh" }),
      ),
    );

    const text = "errorText" in reply ? reply.errorText : "";
    expect(text.match(/ssh/g)).toHaveLength(1);
  });

  it("flags a node for review without refusing it", async () => {
    const reply = await mockDriver.upload(
      upload(
        workflow(
          { type: "n8n-nodes-base.code" },
          { type: "n8n-nodes-base.httpRequest" },
        ),
      ),
    );

    expect(reply).not.toHaveProperty("ok");
    expect("flaggedNodes" in reply && reply.flaggedNodes.split(",").sort()).toEqual([
      "n8n-nodes-base.code",
      "n8n-nodes-base.httpRequest",
    ]);
  });
});

describe("upload — the credential durability rule", () => {
  it("marks a type with no consent flow as blocked", async () => {
    const reply = await mockDriver.upload(
      upload(
        workflow({
          type: "n8n-nodes-base.googleSheets",
          credentials: { googleSheetsOAuth2Api: { id: "1" } },
        }),
      ),
    );

    expect(reply).toMatchObject({ credentialDurability: "blocked" });
  });

  it("marks a secret-based type as durable", async () => {
    const reply = await mockDriver.upload(
      upload(
        workflow({
          type: "n8n-nodes-base.slack",
          credentials: { slackApi: { id: "1" } },
        }),
      ),
    );

    expect(reply).toMatchObject({
      credentialDurability: "durable",
      requiredCredentials: "slackApi",
    });
  });

  it("collects the external hosts a workflow reaches", async () => {
    const reply = await mockDriver.upload(
      upload(
        workflow({
          type: "n8n-nodes-base.httpRequest",
          parameters: { url: "https://api.example.com/v1/items" },
        }),
      ),
    );

    expect("externalHosts" in reply && reply.externalHosts).toContain(
      "api.example.com",
    );
  });
});

describe("install", () => {
  it("refuses a credential type whose sign-in flow does not exist yet", async () => {
    const reply = await mockDriver.install({
      userId: "u1",
      templateId: "tpl_1",
      storageBackend: "platform",
      credentialsJson: JSON.stringify({ googleSheetsOAuth2Api: { token: "x" } }),
    });

    expect(reply).toMatchObject({ ok: false });
    expect("errorText" in reply && reply.errorText).toContain(
      "googleSheetsOAuth2Api",
    );
  });

  it("installs when every credential is one the platform can actually collect", async () => {
    const reply = await mockDriver.install({
      userId: "u1",
      templateId: "tpl_1",
      storageBackend: "platform",
      credentialsJson: JSON.stringify({ slackApi: { accessToken: "x" } }),
    });

    expect("installationId" in reply && reply.installationId).toMatch(/^inst_/);
    expect(reply).toMatchObject({ storageBackend: "platform" });
  });

  it("refuses credentials that are not JSON", async () => {
    const reply = await mockDriver.install({
      userId: "u1",
      templateId: "tpl_1",
      storageBackend: "platform",
      credentialsJson: "{oops",
    });

    expect(reply).toMatchObject({ ok: false });
  });
});

describe("uninstall", () => {
  it("needs the confirmation word the workflow looks for", async () => {
    expect(
      await mockDriver.uninstall({ installationId: "i1", userId: "u1", confirm: "yes" }),
    ).toMatchObject({ reason: "لم يتم التأكيد" });
  });

  it("removes the credential once confirmed", async () => {
    expect(
      await mockDriver.uninstall({ installationId: "i1", userId: "u1", confirm: "نعم" }),
    ).toMatchObject({ credentialCount: 1 });
  });
});

describe("dispatch — the deterministic argument validator", () => {
  const schema = [
    { name: "sheetUrl", required: true },
    { name: "note", required: false },
  ];

  it("refuses to start on a missing required value", async () => {
    const reply = await mockDriver.dispatch({
      userId: "u1",
      installationId: "i1",
      args: { __schema: schema },
    });

    expect(reply).toMatchObject({ result: "incomplete", missing: "sheetUrl" });
  });

  it.each([undefined, null, ""])("treats %p as missing", async (value) => {
    const reply = await mockDriver.dispatch({
      userId: "u1",
      installationId: "i1",
      args: { __schema: schema, sheetUrl: value },
    });

    expect(reply).toMatchObject({ result: "incomplete" });
  });

  it("does not demand an optional field", async () => {
    const reply = await mockDriver.dispatch({
      userId: "u1",
      installationId: "i1",
      args: { __schema: schema, sheetUrl: "https://example.com/s" },
    });

    expect(reply).toMatchObject({ result: "success" });
  });

  it("treats a field with no required flag as required", async () => {
    const reply = await mockDriver.dispatch({
      userId: "u1",
      installationId: "i1",
      args: { __schema: [{ name: "who" }] },
    });

    expect(reply).toMatchObject({ result: "incomplete", missing: "who" });
  });

  it("names every missing field, not just the first", async () => {
    const reply = await mockDriver.dispatch({
      userId: "u1",
      installationId: "i1",
      args: { __schema: [{ name: "a" }, { name: "b" }] },
    });

    expect(reply).toMatchObject({ missing: "a,b" });
  });

  it("does not echo the schema back as if it were user input", async () => {
    const reply = await mockDriver.dispatch({
      userId: "u1",
      installationId: "i1",
      args: { __schema: schema, sheetUrl: "https://example.com/s" },
    });

    const output = "toolOutput" in reply ? JSON.parse(reply.toolOutput) : {};
    expect(output.received).toEqual({ sheetUrl: "https://example.com/s" });
  });
});

describe("storage — the path guard and the round trip", () => {
  const put = (installationId: string, path: string, text: string) =>
    mockDriver.storage({
      installationId,
      operation: "put",
      path,
      content: Buffer.from(text).toString("base64"),
      mimeType: "text/plain",
    });

  // Each test writes under its own installation id, so the store being shared
  // across the module cannot make one test depend on another having run.

  it.each([
    "../etc/passwd",
    "results/../../secret",
    "..",
  ])("refuses the path %s", async (path) => {
    const reply = await mockDriver.storage({
      installationId: "guard",
      operation: "get",
      path,
    });

    expect(reply).toEqual({ ok: false, error: "Rejected path" });
  });

  it("refuses a bad path on put, before anything is written", async () => {
    expect(await put("guard", "../escape.txt", "x")).toMatchObject({ ok: false });

    const listed = await mockDriver.storage({
      installationId: "guard",
      operation: "list",
      path: "",
    });
    expect(listed).toMatchObject({ count: 0 });
  });

  it("stores and returns the same bytes", async () => {
    const written = await put("round-trip", "out/report.txt", "hello");
    expect(written).toMatchObject({ ok: true, size: 5 });

    const read = await mockDriver.storage({
      installationId: "round-trip",
      operation: "get",
      path: "out/report.txt",
    });

    expect(read).toMatchObject({ ok: true, mimeType: "text/plain" });
    const content = "content" in read ? read.content : "";
    expect(Buffer.from(content, "base64").toString()).toBe("hello");
  });

  it("reports a file that was never written", async () => {
    const read = await mockDriver.storage({
      installationId: "empty",
      operation: "get",
      path: "nothing.txt",
    });

    expect(read).toMatchObject({ ok: false });
  });

  it("keeps one installation's files out of another's", async () => {
    await put("tenant-a", "private.txt", "a secret");

    const fromB = await mockDriver.storage({
      installationId: "tenant-b",
      operation: "get",
      path: "private.txt",
    });

    expect(fromB).toMatchObject({ ok: false });
  });

  it("lists and deletes", async () => {
    await put("listing", "one.txt", "1");
    await put("listing", "two.txt", "22");

    const listed = await mockDriver.storage({
      installationId: "listing",
      operation: "list",
      path: "",
    });
    expect(listed).toMatchObject({ count: 2 });

    expect(
      await mockDriver.storage({
        installationId: "listing",
        operation: "delete",
        path: "one.txt",
      }),
    ).toMatchObject({ deleted: 1 });

    // Deleting what is already gone reports 0 rather than failing.
    expect(
      await mockDriver.storage({
        installationId: "listing",
        operation: "delete",
        path: "one.txt",
      }),
    ).toMatchObject({ deleted: 0 });
  });
});

describe("chat", () => {
  it("answers in terms of the session it was given", async () => {
    const reply = await mockDriver.chat({ sessionId: "user-123", chatInput: "hi" });
    expect(reply.output).toContain("user-123");
  });
});

describe("credentialSchema", () => {
  it("returns the fields a connect form should render", async () => {
    const schema = await mockDriver.credentialSchema("slackApi");
    expect(schema?.required).toEqual(["accessToken"]);
    expect(schema?.properties.accessToken.format).toBe("password");
  });

  it("returns null for a type it has no schema for", async () => {
    expect(await mockDriver.credentialSchema("nonesuch")).toBeNull();
  });
});

describe("contentHash", () => {
  it("is stable for the same file and different for a changed one", () => {
    expect(contentHash("abc")).toBe(contentHash("abc"));
    expect(contentHash("abc")).not.toBe(contentHash("abd"));
    expect(contentHash("abc")).toHaveLength(16);
  });
});
