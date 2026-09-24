import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { env } from "./env";

const COOKIE = "builder_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

const key = new TextEncoder().encode(env.authSecret);

export type SessionPayload = {
  userId: string;
};

export async function createSession(userId: string) {
  const token = await new SignJWT({ userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(key);

  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function destroySession() {
  const jar = await cookies();
  jar.delete(COOKIE);
}

/**
 * The single place a user id enters the system. Every call into n8n takes the id
 * from here — never from a request body, a query string or a model's output.
 * The dispatcher checks that userId and installationId agree, but that only
 * protects the user if the platform is honest about what it sends.
 */
export async function readSession(): Promise<SessionPayload | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    const userId = payload.userId;
    return typeof userId === "string" ? { userId } : null;
  } catch {
    return null;
  }
}
