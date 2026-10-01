import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Where the OAuth start route sends people, behind a proxy.
 *
 * On Railway the server only knows its own listening address, so `request.url`
 * says https://0.0.0.0:8080. A redirect built from it strands the browser on a
 * host that exists inside the container. These tests pin that every redirect is
 * built from the app's public address, and that a deployment missing a Google
 * setting says so instead of redirecting to nothing.
 *
 * lib/env.ts reads process.env once at import, so each case sets the environment
 * first and imports a fresh copy of the route.
 */

const KEYS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "PUBLIC_URL",
] as const;
const saved: Record<string, string | undefined> = {};

const INTERNAL = "https://0.0.0.0:8080";

async function loadStart(
  env: Partial<Record<(typeof KEYS)[number], string | null>>,
  user: { id: string; roles: string[] } = { id: "u1", roles: ["USER"] },
) {
  for (const key of KEYS) {
    const value = key in env ? env[key] : saved[key];
    if (value === null || value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  vi.doMock("@/lib/auth", () => ({ requireUser: async () => user }));
  return import("@/app/api/oauth/google/start/route");
}

function call(
  start: { GET: (request: Request) => Promise<Response> },
  { headers = {}, path = "/api/oauth/google/start?returnTo=%2Fmarketplace%2Fchat%2Fsetup" } = {},
) {
  return start.GET(new Request(`${INTERNAL}${path}`, { headers }));
}

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.doUnmock("@/lib/auth");
  vi.doUnmock("@/lib/oauth-state");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("a configured deployment", () => {
  it("goes to Google whatever address the server thinks it has", async () => {
    const res = await call(await loadStart({}));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("redirect_uri")).toBe(process.env.GOOGLE_REDIRECT_URI);
    expect(res.headers.get("set-cookie")).toMatch(/g_oauth=/);
  });

  it("can derive the redirect URI from PUBLIC_URL alone", async () => {
    const res = await call(await loadStart({ GOOGLE_REDIRECT_URI: null, PUBLIC_URL: "https://pub.example.test" }));
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://pub.example.test/api/oauth/google/callback",
    );
  });
});

describe("an unconfigured deployment", () => {
  it("returns the person to where they were, on the public address, with a reason — not a silent redirect to the internal one", async () => {
    const res = await call(await loadStart({ GOOGLE_CLIENT_SECRET: null }));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("https://app.example.test");
    expect(location.pathname).toBe("/marketplace/chat/setup");
    expect(location.searchParams.get("connect_error")).toBe("not_configured");
    expect(location.searchParams.has("connect_missing")).toBe(false);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("logs which settings are missing, by name and never a value", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await call(await loadStart({ GOOGLE_CLIENT_ID: null, GOOGLE_CLIENT_SECRET: null }));
    const logged = error.mock.calls.flat().join(" ");
    expect(logged).toContain("GOOGLE_CLIENT_ID");
    expect(logged).toContain("GOOGLE_CLIENT_SECRET");
    expect(logged).not.toContain("test-client-secret");
    expect(logged).not.toContain("test-client-id");
  });

  it("names all three when none is set, and builds the redirect from the proxy's forwarded address", async () => {
    const res = await call(
      await loadStart({ GOOGLE_CLIENT_ID: null, GOOGLE_CLIENT_SECRET: null, GOOGLE_REDIRECT_URI: null, PUBLIC_URL: null }),
      { headers: { "x-forwarded-host": "marketplace.example.com", "x-forwarded-proto": "https" } },
    );
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("https://marketplace.example.com");
  });

  it("is the case that happened: only the redirect URI missing, behind a proxy", async () => {
    const res = await call(
      await loadStart({ GOOGLE_REDIRECT_URI: null, PUBLIC_URL: null }),
      { headers: { "x-forwarded-host": "marketplace.example.com", "x-forwarded-proto": "https" } },
    );
    const location = new URL(res.headers.get("location")!);
    expect(location.host).not.toContain("0.0.0.0");
    expect(location.origin).toBe("https://marketplace.example.com");
  });

  it("prefers the configured public address over forwarded headers", async () => {
    const res = await call(await loadStart({ GOOGLE_CLIENT_SECRET: null, PUBLIC_URL: "https://pub.example.test" }), {
      headers: { "x-forwarded-host": "other.example.test", "x-forwarded-proto": "https" },
    });
    expect(new URL(res.headers.get("location")!).origin).toBe("https://pub.example.test");
  });

  it("ignores a malformed forwarded host and falls back to the request's own", async () => {
    for (const host of ["evil.com/path", "a b", "evil.com@x.test", "<script>"]) {
      const res = await call(
        await loadStart({ GOOGLE_CLIENT_SECRET: null, GOOGLE_REDIRECT_URI: null, PUBLIC_URL: null }),
        { headers: { "x-forwarded-host": host, "x-forwarded-proto": "https" } },
      );
      expect(new URL(res.headers.get("location")!).origin).toBe(INTERNAL);
    }
  });

  it("ignores a forwarded protocol that is not http or https", async () => {
    const res = await call(
      await loadStart({ GOOGLE_CLIENT_SECRET: null, GOOGLE_REDIRECT_URI: null, PUBLIC_URL: null }),
      { headers: { "x-forwarded-host": "marketplace.example.com", "x-forwarded-proto": "javascript" } },
    );
    expect(new URL(res.headers.get("location")!).origin).toBe(INTERNAL);
  });

  it("never sends the person anywhere but a path on this app", async () => {
    const res = await call(await loadStart({ GOOGLE_CLIENT_SECRET: null }), {
      path: "/api/oauth/google/start?returnTo=https%3A%2F%2Fevil.example%2Fx",
    });
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("https://app.example.test");
    expect(location.pathname).not.toContain("evil");
  });
});

describe("when starting fails", () => {
  it("returns the person with a message and logs the reason", async () => {
    vi.doMock("@/lib/oauth-state", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/oauth-state")>()),
      newOAuthState: () => {
        throw new Error("boom");
      },
    }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call(await loadStart({}));
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("https://app.example.test");
    expect(location.searchParams.get("connect_error")).toBe("unavailable");
    expect(error).toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("connectErrorText", () => {
  async function banner(
    env: Partial<Record<(typeof KEYS)[number], string | null>>,
    code: string | undefined = "not_configured",
  ) {
    for (const key of KEYS) {
      const value = key in env ? env[key] : saved[key];
      if (value === null || value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
    const { connectErrorText } = await import("@/lib/google-oauth");
    return connectErrorText(code);
  }

  it("names exactly the settings that are missing", async () => {
    expect(await banner({ GOOGLE_CLIENT_SECRET: null })).toBe(
      "Google sign-in is not set up on the server yet. Missing: GOOGLE_CLIENT_SECRET.",
    );
    expect(await banner({ GOOGLE_CLIENT_ID: null, GOOGLE_REDIRECT_URI: null, PUBLIC_URL: null })).toBe(
      "Google sign-in is not set up on the server yet. Missing: GOOGLE_CLIENT_ID, GOOGLE_REDIRECT_URI.",
    );
  });

  it("does not report the redirect URI as missing when PUBLIC_URL provides it", async () => {
    const text = await banner({ GOOGLE_CLIENT_SECRET: null, GOOGLE_REDIRECT_URI: null, PUBLIC_URL: "https://pub.example.test" });
    expect(text).toContain("GOOGLE_CLIENT_SECRET");
    expect(text).not.toContain("GOOGLE_REDIRECT_URI");
  });

  it("never contains a setting's value", async () => {
    const text = await banner({ GOOGLE_CLIENT_ID: null });
    for (const key of ["GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"] as const) {
      expect(text).not.toContain(process.env[key]!);
    }
  });

  it("is the plain message if everything is configured by the time the page renders", async () => {
    expect(await banner({})).toBe("Google sign-in is not set up on the server yet.");
  });

  it("cannot be made to say anything by the URL — it takes only the code", async () => {
    const { connectErrorText } = await import("@/lib/google-oauth");
    expect(connectErrorText.length).toBe(1);
  });

  it("falls back to the generic message for an unknown or absent code", async () => {
    const { CONNECT_ERRORS } = await import("@/lib/google-oauth");
    expect(await banner({}, "nope")).toBe(CONNECT_ERRORS.google);
    expect(await banner({}, "")).toBe(CONNECT_ERRORS.google);
  });
});
