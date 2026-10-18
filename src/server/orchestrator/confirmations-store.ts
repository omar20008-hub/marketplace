import "server-only";
import { prisma } from "@/lib/db";
import { argsKey, isAffirmation, NO_CONFIRMATION, type ConfirmationGate } from "./confirmations";

/**
 * The confirmation gate kept in the platform database, so a proposal made in one
 * message can be confirmed by the next one. Without a thread and a message to
 * anchor to, there is nothing to match, so the gate confirms nothing.
 */

export const CONFIRMATION_WINDOW_MS = 30 * 60 * 1000;

export function databaseConfirmations({
  userId,
  threadId,
  currentMessageId,
  userMessage,
  now = new Date(),
}: {
  userId: string;
  threadId?: string;
  currentMessageId?: string;
  userMessage: string;
  now?: Date;
}): ConfirmationGate {
  if (!threadId || !currentMessageId) return NO_CONFIRMATION;

  return {
    async propose(installationId, args) {
      const key = argsKey(args);
      const pending = await prisma.orchestratorPendingAction.findFirst({
        where: { userId, threadId, installationId, argsKey: key, status: "PENDING" },
        select: { id: true },
      });
      if (pending) return;
      await prisma.orchestratorPendingAction.create({
        data: { userId, threadId, installationId, argsKey: key, proposedByMessageId: currentMessageId },
      });
    },

    async confirmed(installationId, args) {
      if (!isAffirmation(userMessage)) return false;

      // A proposal made while answering this very message cannot be confirmed by it.
      const proposal = await prisma.orchestratorPendingAction.findFirst({
        where: {
          userId,
          threadId,
          installationId,
          argsKey: argsKey(args),
          status: "PENDING",
          proposedByMessageId: { not: currentMessageId },
          createdAt: { gte: new Date(now.getTime() - CONFIRMATION_WINDOW_MS) },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (!proposal) return false;

      // Consume it only once, even if two calls race.
      const consumed = await prisma.orchestratorPendingAction.updateMany({
        where: { id: proposal.id, status: "PENDING" },
        data: { status: "CONSUMED" },
      });
      return consumed.count === 1;
    },
  };
}
