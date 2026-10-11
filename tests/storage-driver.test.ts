import { afterEach, describe, expect, it, vi } from "vitest";
import { n8n } from "@/lib/n8n";
import { storageOperation } from "@/server/storage";

/**
 * With the default driver, storage calls go to n8n and are keyed by the n8n id.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const text = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("the storage driver", () => {
  it("sends the call to n8n, keyed by the n8n installation id, when that is selected", async () => {
    const put = vi.spyOn(n8n, "storage").mockResolvedValue({ ok: true, objectRef: "n8n://x", size: 1 });

    const reply = await storageOperation(
      { id: "platform_1", installationId: "inst_n8n" },
      { operation: "put", path: "a", content: text("x") },
    );

    expect(reply).toEqual({ ok: true, objectRef: "n8n://x", size: 1 });
    expect(put).toHaveBeenCalledWith(expect.objectContaining({ installationId: "inst_n8n", operation: "put" }));
  });
});
