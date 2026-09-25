"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { verifyPassword } from "@/lib/auth";
import { createSession, destroySession } from "@/lib/session";
import { clear, hit } from "@/lib/rate-limit";

export type LoginState = { error?: string };

/**
 * Ten tries in fifteen minutes, per address.
 *
 * Loose enough that nobody typing their own password badly will meet it, and
 * tight enough that a password list is no longer worth running. Keyed by the
 * address rather than by IP because the platform sits behind a proxy it does
 * not control, and a forwarded-for header is a claim, not a fact — trusting it
 * would let an attacker reset their own budget on every request.
 *
 * The trade that leaves: someone who knows an address can lock its owner out
 * of the form for a quarter of an hour. Nothing is deleted and nothing is
 * charged, so that is the lesser harm — but it is a real one, and the reason to
 * key on both address and a trusted IP once there is one.
 */
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export async function login(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Enter an email and a password." };
  }

  // Counted before the password is checked, so the limit costs an attacker a
  // bcrypt comparison they do not get to make.
  const limited = hit(`login:${email}`, {
    limit: LOGIN_LIMIT,
    windowMs: LOGIN_WINDOW_MS,
  });
  if (!limited.ok) {
    const minutes = Math.ceil(limited.retryAfterSeconds / 60);
    return {
      error: `Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    };
  }

  const user = await prisma.user.findUnique({ where: { email } });
  // The same message either way: whether an address has an account is not
  // something a sign-in form should tell a stranger.
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return { error: "That email and password do not match." };
  }

  // Getting it right clears the count, so a couple of typos followed by the
  // real password do not leave someone one attempt from a lockout.
  clear(`login:${email}`);

  await createSession(user.id);
  // The whole (app) layout reads the session to decide what to render — the
  // sidebar, and now whether "/" is the guest composer or the real one — so
  // signing in has to invalidate all of it, not just the page being
  // navigated to. Without this, a browser that already has "/" in its
  // client-side Router Cache from before this sign-in keeps showing that
  // cached, signed-out render after the redirect below.
  revalidatePath("/", "layout");
  redirect("/");
}

export async function logout() {
  await destroySession();
  // Same cache-invalidation reason as login() above, in the other direction:
  // without it, "/" is still cached from while this session was signed in.
  revalidatePath("/", "layout");
  // Not /login: the home page already renders for a guest, so signing out
  // lands there — the same page the product opens to for anyone with no
  // session, not a form asking them to sign back in immediately.
  redirect("/");
}
