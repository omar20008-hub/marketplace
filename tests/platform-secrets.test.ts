import { beforeEach, describe, expect, it } from "vitest";

/**
 * The platform's own keys. A key is stored encrypted, read back only for the
 * install path, and never appears in what the admin screen is told.
 */

const { prisma } = await import("@/lib/db");
const { platformCredential, platformKeyStatus, storePlatformSecret } = await import(
  "@/lib/platform-secrets"
);
const { isPlatformHeld } = await import("@/lib/credentials");

const KEY = "AIzaTestPlatformKeyNotReal0001";

beforeEach(async () => {
  await prisma.platformSecret.deleteMany({});
});

describe("platform keys", () => {
  it("stores the key encrypted and hands it back with the fixed host", async () => {
    await storePlatformSecret("googlePalmApi", KEY, "admin-1");

    const row = await prisma.platformSecret.findUniqueOrThrow({
      where: { name: "googlePalmApi" },
    });
    expect(row.secretJson).not.toContain(KEY);

    expect(await platformCredential("googlePalmApi")).toEqual({
      host: "https://generativelanguage.googleapis.com",
      apiKey: KEY,
    });
  });

  it("replaces the key in place when saved again", async () => {
    await storePlatformSecret("googlePalmApi", KEY, "admin-1");
    await storePlatformSecret("googlePalmApi", `${KEY}X`, "admin-2");

    expect(await prisma.platformSecret.count()).toBe(1);
    expect((await platformCredential("googlePalmApi"))?.apiKey).toBe(`${KEY}X`);
  });

  it("reports where a stored key comes from, never its value", async () => {
    await storePlatformSecret("googlePalmApi", KEY, "admin-1");
    const status = await platformKeyStatus("googlePalmApi");

    expect(status.source).toBe("stored");
    expect(status.updatedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(status)).not.toContain(KEY);
  });

  it("gives nothing for a type the platform does not hold", async () => {
    await storePlatformSecret("googlePalmApi", KEY, "admin-1");
    expect(await platformCredential("openAiApi")).toBeNull();
    expect(isPlatformHeld("openAiApi")).toBe(false);
    expect(isPlatformHeld("googlePalmApi")).toBe(true);
  });
});
