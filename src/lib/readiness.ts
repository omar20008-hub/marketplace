import type { BadgeTone } from "@/components/ds";
import type {
  AccountStatus,
  InstallationStatus,
  ProductStatus,
  ProvidedBy,
} from "@/generated/prisma";

/**
 * "Does it work for me" — the one question every marketplace card, product page
 * and workspace row answers. It is computed in one place so the badge on a card
 * can never disagree with the badge on the page it leads to.
 */

export type Readiness = {
  tone: BadgeTone;
  label: string;
  /** Requirements the user still has to connect themselves. */
  missing: string[];
};

type RequirementLike = {
  label: string;
  credentialType: string | null;
  providedBy: ProvidedBy;
};

type AccountLike = {
  credentialType: string;
  status: AccountStatus;
};

export function readinessFor({
  productStatus,
  requirements,
  accounts,
  installed,
  installationStatus,
  overPlanLimit = false,
}: {
  productStatus: ProductStatus;
  requirements: RequirementLike[];
  accounts: AccountLike[];
  installed?: boolean;
  installationStatus?: InstallationStatus;
  overPlanLimit?: boolean;
}): Readiness {
  if (productStatus === "SUSPENDED" || productStatus === "SECURITY_HOLD") {
    return { tone: "blocked", label: "Suspended", missing: [] };
  }

  // Restricted means existing users keep running; only new installs are closed.
  if (productStatus === "RESTRICTED" && !installed) {
    return { tone: "restricted", label: "Restricted", missing: [] };
  }

  // Out of runs for the month, or out of credits for a product that spends
  // them. Either way the answer is the plan, not a connection.
  if (overPlanLimit) {
    return { tone: "plan", label: "Plan limit", missing: [] };
  }

  const byType = new Map(accounts.map((a) => [a.credentialType, a.status]));
  const mine = requirements.filter((r) => r.providedBy === "USER");

  // Never connected at all, versus connected and since expired. The two look
  // the same to a set of active types, but they are different problems: one
  // needs setting up, the other needs reconnecting.
  const absent: string[] = [];
  const expired: string[] = [];
  for (const requirement of mine) {
    const status = requirement.credentialType
      ? byType.get(requirement.credentialType)
      : undefined;
    if (status === "ACTIVE") continue;
    if (status === "EXPIRED") expired.push(requirement.label);
    else absent.push(requirement.label);
  }

  if (installationStatus === "DISABLED") {
    return { tone: "blocked", label: "Disabled", missing: [...expired, ...absent] };
  }

  // On something already in the workspace, an expired account is the next run
  // failing, not a setup step — so it reads as blocked, not partially ready.
  if (installed && expired.length > 0) {
    return { tone: "blocked", label: "Blocked", missing: expired };
  }

  const missing = [...absent, ...expired];
  if (missing.length > 0) {
    return {
      tone: "partial",
      label: installed
        ? "Partially ready"
        : `Needs ${missing.length} connection${missing.length > 1 ? "s" : ""}`,
      missing,
    };
  }

  return { tone: "ready", label: "Ready", missing: [] };
}

export function planUsage(plan: {
  monthlyRuns: number;
  storageBytes: bigint;
}) {
  return {
    monthlyRuns: plan.monthlyRuns,
    storageBytes: Number(plan.storageBytes),
  };
}

export function formatBytes(bytes: number) {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function formatDuration(ms: number | null | undefined) {
  if (!ms && ms !== 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

export function formatDate(date: Date | null | undefined) {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(date);
}

export function formatDay(date: Date | null | undefined) {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(date);
}

export function timeOfDay(date: Date) {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date);
}

export function relativeDays(date: Date | null | undefined, now = new Date()) {
  if (!date) return "—";
  const days = Math.floor((now.getTime() - date.getTime()) / 86_400_000);
  if (days <= 0) {
    const hours = Math.max(1, Math.floor((now.getTime() - date.getTime()) / 3_600_000));
    return `${hours}h ago`;
  }
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return `${months} month${months > 1 ? "s" : ""} ago`;
}

export function waitingFor(date: Date, now = new Date()) {
  const hours = Math.floor((now.getTime() - date.getTime()) / 3_600_000);
  if (hours < 24) return `${Math.max(1, hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}
