"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { deleteUserFile } from "./files/user-files";

/** Removes one of the person's saved files, with the text read from it. */
export async function removeFileAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  if (id) await deleteUserFile(user.id, id);
  revalidatePath("/files");
}
