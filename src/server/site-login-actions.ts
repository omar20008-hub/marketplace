"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { deleteSiteLogin, saveSiteLogin } from "./site-logins";

/**
 * Saves a login typed into the one-time link page, and deletes one from the
 * Saved logins tab. The password is read from the form and passed straight to
 * the sealing step: it is not logged, not echoed back, and not put in a URL.
 */

export async function saveLoginAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const token = String(formData.get("token") ?? "");
  const result = await saveSiteLogin({
    userId: user.id,
    token,
    username: String(formData.get("username") ?? ""),
    password: String(formData.get("password") ?? ""),
  });
  if (!result.ok) {
    redirect(`/logins/add/${encodeURIComponent(token)}?error=${result.reason}`);
  }
  revalidatePath("/logins");
  redirect("/logins?saved=1");
}

export async function removeLoginAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  if (id) await deleteSiteLogin(user.id, id);
  revalidatePath("/logins");
}
