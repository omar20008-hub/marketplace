"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import {
  addFact,
  clearMemory,
  createFile,
  deleteFile,
  getFile,
  renameFile,
  saveFile,
} from "./memory";

/**
 * The Memory page. Every action works on the signed-in user's own files only, and each
 * one ends by redirecting to the page with a short `note`, so a message from one action
 * never lingers into the next.
 */

function back(fileId: string | null, note?: string): never {
  revalidatePath("/memory");
  const params = new URLSearchParams();
  if (fileId) params.set("file", fileId);
  if (note) params.set("note", note);
  const query = params.toString();
  redirect(query ? `/memory?${query}` : "/memory");
}

const text = (formData: FormData, key: string) => String(formData.get(key) ?? "");

export async function createMemoryFileAction(formData: FormData) {
  const user = await requireUser();
  const result = await createFile(user.id, text(formData, "name"));
  if (result.ok) back(result.id, "created");
  back(null, result.reason);
}

export async function saveMemoryFileAction(formData: FormData) {
  const user = await requireUser();
  const id = text(formData, "id");
  const result = await saveFile(user.id, id, text(formData, "content"));
  if (result.ok) back(id, "saved");
  back(id, result.reason === "sensitive" ? `sensitive-${result.line}` : result.reason);
}

export async function addMemoryLineAction(formData: FormData) {
  const user = await requireUser();
  const id = text(formData, "id");
  const file = await getFile(user.id, id);
  if (!file) back(null, "not_found");
  const result = await addFact(user.id, text(formData, "content"), { file: file.name });
  back(id, result.ok ? "saved" : result.reason);
}

export async function renameMemoryFileAction(formData: FormData) {
  const user = await requireUser();
  const id = text(formData, "id");
  const result = await renameFile(user.id, id, text(formData, "name"));
  back(id, result.ok ? "renamed" : result.reason);
}

export async function deleteMemoryFileAction(formData: FormData) {
  const user = await requireUser();
  if (formData.get("confirm") !== "yes") back(text(formData, "id"), "confirm");
  await deleteFile(user.id, text(formData, "id"));
  back(null, "deleted");
}

export async function clearMemoriesAction(formData: FormData) {
  const user = await requireUser();
  if (formData.get("confirm") !== "yes") back(null, "confirm");
  await clearMemory(user.id);
  back(null, "cleared");
}

export async function setAutoMemoryAction(formData: FormData) {
  const user = await requireUser();
  await prisma.user.update({
    where: { id: user.id },
    data: { memoryAuto: formData.get("auto") === "on" },
  });
  back(text(formData, "file") || null);
}
