import { GoogleIcon } from "./google-icon";

/**
 * "Continue with Google", on both the sign-in and the sign-up form. One route
 * serves both: it signs an existing address in and creates an account for a
 * new one.
 */
export function GoogleButton({ label }: { label: string }) {
  return (
    <>
      <div className="mt-6 flex items-center gap-3">
        <div className="flex-1 border-t border-selected" />
        <p className="text-xs text-ink-3">or</p>
        <div className="flex-1 border-t border-selected" />
      </div>

      <a
        href="/api/oauth/google/auth/start"
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-row border border-selected px-4 py-2.5 font-medium hover:bg-fill"
      >
        <GoogleIcon className="h-5 w-5" />
        {label}
      </a>
    </>
  );
}
