"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { verifyPassword } from "@/lib/auth";
import { createSession, destroySession } from "@/lib/session";

export type LoginState = { error?: string };

export async function login(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Enter an email and a password." };
  }

  const user = await prisma.user.findUnique({ where: { email } });
  // The same message either way: whether an address has an account is not
  // something a sign-in form should tell a stranger.
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return { error: "That email and password do not match." };
  }

  await createSession(user.id);
  redirect("/");
}

export async function logout() {
  await destroySession();
  redirect("/login");
}
