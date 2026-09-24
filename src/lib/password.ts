import bcrypt from "bcryptjs";

/**
 * Hashing a password, and checking one.
 *
 * Separate from lib/auth.ts, which begins with `import "server-only"` and pulls
 * in next/navigation — neither of which a plain script can load. The operator
 * script that creates the first account on a fresh deployment needs to produce
 * a hash the sign-in form will accept, and the only safe way to guarantee that
 * is for both to call the same function. Two copies with two cost factors would
 * work on the day they were written and quietly diverge afterwards.
 *
 * lib/auth.ts re-exports both, so nothing that imported them from there had to
 * change.
 */

/**
 * bcrypt's work factor. Ten is the library's own default: comfortably slow for
 * an attacker with the hashes, comfortably fast for a sign-in form. Raising it
 * is safe for new passwords and does not invalidate old ones — bcrypt stores
 * the cost inside the hash, so `compare` keeps working across a change.
 */
const COST = 10;

export async function hashPassword(plain: string) {
  return bcrypt.hash(plain, COST);
}

export async function verifyPassword(plain: string, hash: string) {
  return bcrypt.compare(plain, hash);
}
