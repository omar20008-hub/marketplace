import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { MIN_PASSWORD_LENGTH } from "@/lib/password";
import { AuthShell } from "../login/auth-shell";
import { SignupForm } from "./signup-form";

export const metadata = { title: "Create an account · Builder" };

export default async function SignupPage() {
  if (await currentUser()) redirect("/");

  return (
    <AuthShell title="Create an account" lede="Agents you can run, from a marketplace you can trust.">
      <SignupForm minPasswordLength={MIN_PASSWORD_LENGTH} />
    </AuthShell>
  );
}
