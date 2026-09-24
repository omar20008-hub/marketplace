import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in · Builder" };

export default async function LoginPage() {
  if (await currentUser()) redirect("/");

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
          Agents and workflows you can run, from a marketplace you can trust.
        </p>

        <LoginForm />
      </div>
    </div>
  );
}
