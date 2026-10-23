import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { AuthShell } from "./auth-shell";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in · Builder" };

const AUTH_ERRORS: Record<string, string> = {
  not_configured: "Google sign-in is not set up on the server yet.",
  unavailable: "Google sign-in could not be started. Try again in a moment.",
  denied: "Google sign-in was cancelled.",
  state: "That sign-in link expired. Try again.",
  identity: "Google did not confirm a verified email for this account.",
  google: "Google could not complete sign-in. Try again in a moment.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ auth_error?: string }>;
}) {
  if (await currentUser()) redirect("/");
  const { auth_error } = await searchParams;
  const authError = auth_error ? (AUTH_ERRORS[auth_error] ?? AUTH_ERRORS.google) : null;

  return (
    <AuthShell title="Sign in" lede="Agents you can run, from a marketplace you can trust.">
      {authError ? <p className="mt-6 text-[13px] text-danger-ink">{authError}</p> : null}

      <LoginForm />
    </AuthShell>
  );
}
