import "server-only";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { n8n, type StorageInput, type StorageOutput } from "@/lib/n8n";

/**
 * What MP · Storage API did: put, get, list and delete a product's files on the
 * platform's own storage destination. Every operation first checks that the
 * installation is active, and any path with ".." is refused before anything is read
 * or written.
 *
 * The platform's files live in the platform's database, keyed by the platform
 * installation, so one installation cannot reach another's files. With
 * STORAGE_DRIVER=n8n the same call goes to the n8n Storage API instead.
 */

export const MAX_OBJECT_BYTES = 25 * 1024 * 1024;

export type StorageTarget = {
  /** The platform installation id. */
  id: string;
  /** The id the n8n copy knows it by. */
  installationId: string | null;
};

function normalisePath(raw: string, operation: StorageInput["operation"]): { path: string } | { error: string } {
  const path = raw.replace(/^\/+/, "");
  if (operation !== "list" && path === "") return { error: "المسار مطلوب" };
  if (path.includes("..")) return { error: "مسار غير مسموح" };
  return { path };
}

async function isActive(installationId: string): Promise<boolean> {
  const installation = await prisma.installation.findFirst({
    where: { id: installationId, status: "ACTIVE" },
    select: { id: true },
  });
  return installation !== null;
}

async function platformOperation(target: StorageTarget, input: Omit<StorageInput, "installationId">): Promise<StorageOutput> {
  if (!(await isActive(target.id))) {
    return { ok: false, error: "تثبيت غير معروف أو موقوف" };
  }

  const checked = normalisePath(input.path, input.operation);
  if ("error" in checked) return { ok: false, error: checked.error };
  const { path } = checked;

  switch (input.operation) {
    case "put": {
      const bytes = Buffer.from(input.content ?? "", "base64");
      if (bytes.length > MAX_OBJECT_BYTES) return { ok: false, error: "الملف أكبر من الحد المسموح" };
      const mimeType = input.mimeType || "application/octet-stream";
      await prisma.storageObject.upsert({
        where: { installationId_path: { installationId: target.id, path } },
        create: { installationId: target.id, path, mimeType, size: bytes.length, content: bytes },
        update: { mimeType, size: bytes.length, content: bytes, writtenAt: new Date() },
      });
      return { ok: true, objectRef: `platform://${target.id}/${path}`, size: bytes.length };
    }

    case "get": {
      const object = await prisma.storageObject.findUnique({
        where: { installationId_path: { installationId: target.id, path } },
      });
      if (!object) return { ok: false, error: "الملف غير موجود" };
      return {
        ok: true,
        content: Buffer.from(object.content).toString("base64"),
        mimeType: object.mimeType,
      };
    }

    case "list": {
      const objects = await prisma.storageObject.findMany({
        where: { installationId: target.id, path: { startsWith: path } },
        select: { path: true, size: true, mimeType: true },
        orderBy: { path: "asc" },
      });
      return { ok: true, count: objects.length, files: objects };
    }

    case "delete": {
      const { count } = await prisma.storageObject.deleteMany({
        where: { installationId: target.id, path },
      });
      return { ok: true, deleted: count };
    }
  }
}

export async function storageOperation(
  target: StorageTarget,
  input: Omit<StorageInput, "installationId">,
): Promise<StorageOutput> {
  if (env.storage.driver === "platform") return platformOperation(target, input);
  return n8n.storage({ ...input, installationId: target.installationId ?? target.id });
}
