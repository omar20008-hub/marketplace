"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { addMemory } from "./memory";

/** The Memory page. Every action works on the signed-in user's own rows only. */

export async function addMemoryAction(formData: FormData) {
  const user = await requireUser();
  const result = await addMemory(user.id, String(formData.get("content") ?? ""), "EXPLICIT");
  revalidatePath("/memory");
  redirect(`/memory?note=${result.ok ? "saved" : result.reason}`);
}

export async function deleteMemoryAction(formData: FormData) {
  const user = await requireUser();
  await prisma.userMemory.deleteMany({
    where: { id: String(formData.get("id") ?? ""), userId: user.id },
  });
  revalidatePath("/memory");
}

export async function clearMemoriesAction(formData: FormData) {
  const user = await requireUser();
  if (formData.get("confirm") !== "yes") redirect("/memory?note=confirm");
  await prisma.userMemory.deleteMany({ where: { userId: user.id } });
  revalidatePath("/memory");
  redirect("/memory?note=cleared");
}

export async function setAutoMemoryAction(formData: FormData) {
  const user = await requireUser();
  await prisma.user.update({
    where: { id: user.id },
    data: { memoryAuto: formData.get("auto") === "on" },
  });
  revalidatePath("/memory");
}
