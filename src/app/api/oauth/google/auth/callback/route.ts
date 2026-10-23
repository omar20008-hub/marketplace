import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { after, NextResponse } from "next/server";
import { hashPassword } from "@/lib/auth";
import { installReadyProducts } from "@/server/auto-install";
import { prisma } from "@/lib/db";
import {
  GOOGLE_AUTH_CALLBACK_PATH,
  appUrl,
  exchangeCode,
  identityFromIdToken,
} from "@/lib/google-oauth";
import {
  OAUTH_COOKIE,
  OAUTH_COOKIE_PATH,
  cookieValue,
  readOAuthState,
} from "@/lib/oauth-state";
import { createSession } from "@/lib/session";
import { WELCOME_PATH } from "@/lib/onboarding";

/**
 * Where Google sends someone who chose "Sign in with Google". The state cookie
 * must match the nonce Google echoes back. Nobody is signed in yet, so the state
 * is bound to no user.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);

  const finish = (path: string, params: Record<string, string>) => {
    const response = NextResponse.redirect(appUrl(path, params, request));
    response.cookies.set(OAUTH_COOKIE, "", { path: OAUTH_COOKIE_PATH, maxAge: 0 });
    return response;
  };

  const state = readOAuthState(
    cookieValue(request.headers.get("cookie"), OAUTH_COOKIE),
    url.searchParams.get("state"),
    "",
  );
  if (!state) return finish("/login", { auth_error: "state" });

  if (url.searchParams.get("error")) return finish("/login", { auth_error: "denied" });

  const code = url.searchParams.get("code");
  if (!code) return finish("/login", { auth_error: "google" });

  try {
    const tokens = await exchangeCode(
      code,
      state.verifier,
      appUrl(GOOGLE_AUTH_CALLBACK_PATH, {}, request),
    );
    const identity = identityFromIdToken(tokens.idToken);
    if (!identity) return finish("/login", { auth_error: "identity" });

    let user = await prisma.user.findUnique({ where: { email: identity.email } });
    let created = false;
    // A new account starts on the welcome page, which offers WhatsApp or the
    // platform's own chat; someone signing back in goes where they were headed.
    let returnTo = state.returnTo;
    if (!user) {
      returnTo = WELCOME_PATH;
      const local = identity.email.split("@")[0];
      user = await prisma.user.create({
        data: {
          email: identity.email,
          name: local,
          initials: (local[0] ?? "U").toUpperCase(),
          // Random and never shown: a Google-only account signs in through Google.
          passwordHash: await hashPassword(randomBytes(32).toString("base64url")),
          planId: "free",
        },
      });
      created = true;
    }

    await createSession(user.id);
    if (created) after(() => installReadyProducts(user.id));
    revalidatePath("/", "layout");
    return finish(returnTo, {});
  } catch (error) {
    console.error("Google sign-in failed", error instanceof Error ? error.message : error);
    return finish("/login", { auth_error: "google" });
  }
}

export const dynamic = "force-dynamic";
