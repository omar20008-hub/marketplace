import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
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
    <div className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-[380px]">
        <div className="mb-8 flex items-center gap-2.5">
          <span className="flex size-[26px] items-center justify-center rounded-[8px] bg-ink text-sm font-semibold text-white">
            B
          </span>
          <span className="text-base font-semibold tracking-[-0.01em]">Builder</span>
        </div>

        <h1 className="text-[30px] leading-tight font-medium tracking-[-0.02em]">
          Sign in
        </h1>
        <p className="mt-2 text-sm text-ink-2">
          Agents you can run, from a marketplace you can trust.
        </p>

        {authError ? <p className="mt-6 text-[13px] text-danger-ink">{authError}</p> : null}

        <LoginForm />
      </div>
    </div>
  );
}
