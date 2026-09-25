/**
 * From the name: "Nora Haddad" becomes NH, "Nora" becomes NO.
 *
 * Shared between scripts/create-admin.ts and the Users tab's create-account
 * form — the same two callers hashPassword/verifyPassword were split out for:
 * one rule, so it cannot drift into two.
 */
export function initialsFor(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return (parts[0] ?? "").slice(0, 2).toUpperCase();
}
