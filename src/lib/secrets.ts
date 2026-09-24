import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { env } from "./env";

/**
 * The vault behind a connected account.
 *
 * The connect screen tells the user their keys are "stored in an encrypted
 * vault and injected only at the moment a run needs them". This is the half of
 * that promise the database can keep: what lands in ConnectedAccount.secretJson
 * is ciphertext, so a stolen dump or a stray backup is not a pile of the user's
 * live credentials.
 *
 * AES-256-GCM, so tampering with a stored row fails loudly at decrypt rather
 * than quietly handing a mangled token to a workflow.
 *
 * What this does NOT protect against: anything that can read SECRETS_KEY. A
 * process with the key and the database has the plaintext, by design — the
 * platform must be able to inject credentials into n8n at install time. Moving
 * the key into a KMS or a hardware module is the next step up, and the only
 * change it needs is inside keyBytes().
 */

const VERSION = "v1";
const IV_BYTES = 12; // GCM standard
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;

function keyBytes(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = env.secretsKey;
  if (!raw) {
    throw new Error(
      "SECRETS_KEY is not set. Generate one with:\n" +
        "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }

  const key = Buffer.from(raw, "hex");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `SECRETS_KEY must be ${KEY_BYTES} bytes as ${KEY_BYTES * 2} hex characters; got ${key.length} bytes.`,
    );
  }

  cachedKey = key;
  return key;
}

/** Returns `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(stored: string): string {
  const parts = stored.split(".");
  if (parts.length !== 4) {
    throw new Error("Stored secret is not in the expected format.");
  }

  const [version, ivPart, tagPart, ciphertextPart] = parts;
  // Compared without branching on content so the version check cannot be used
  // to probe for stored values byte by byte.
  const expected = Buffer.from(VERSION);
  const actual = Buffer.from(version);
  if (
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  ) {
    throw new Error(`Unsupported secret format: ${version}`);
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyBytes(),
    Buffer.from(ivPart, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));

  // Throws if the row was altered; a bad credential should stop a run, not
  // silently reach a workflow as garbage.
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** Encrypts a credential's field map for storage. */
export function sealCredential(values: Record<string, string>): string {
  return encryptSecret(JSON.stringify(values));
}

/** Reads a stored credential back for injection into n8n. */
export function openCredential(stored: string | null): Record<string, string> {
  if (!stored) return {};
  return JSON.parse(decryptSecret(stored)) as Record<string, string>;
}
