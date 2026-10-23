import { requireUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { channelLinkFor, WHATSAPP } from "@/server/channel-links";
import { AuthShell } from "../login/auth-shell";
import { WelcomeChoices } from "./welcome-choices";

export const metadata = { title: "Welcome · Builder" };

/**
 * Where a new account lands, from the sign-up form or from Google: carry on in
 * WhatsApp, or in the platform's own chat. Nothing here is required, and anyone
 * signed in may come back to it.
 */
export default async function WelcomePage() {
  const user = await requireUser();
  const linked = (await channelLinkFor(user.id, WHATSAPP)) !== null;
  const firstName = user.name.trim().split(/\s+/)[0] || user.name;

  return (
    <AuthShell
      title={`Welcome, ${firstName}`}
      lede="Your account is ready. Where would you like to talk to your assistant?"
    >
      <WelcomeChoices businessNumber={env.whatsappBusinessNumber} linked={linked} />
    </AuthShell>
  );
}

export const dynamic = "force-dynamic";
