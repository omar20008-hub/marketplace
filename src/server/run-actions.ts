"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { askOrchestrator, executeRun, fields, titleFor } from "./run-engine";

/**
 * Opens a thread from whatever the person typed. Whether that is a direct
 * question or a request to run something they own is the Orchestrator's call,
 * not this platform's: it builds its tool catalogue from this user's real
 * installations and decides — invent nothing here to second-guess it.
 *
 * "Pick a product" in the composer still lets someone name a product up
 * front; when they do, it rides along as context in the same message rather
 * than skipping the Orchestrator, so the decision to invoke it is still made
 * on that side of the boundary.
 */
export async function startTask(formData: FormData) {
  const user = await requireUser();
  const task = String(formData.get("task") ?? "").trim();
  if (!task) return;

  const pinned = String(formData.get("installationId") ?? "");
  const pinnedInstallation = pinned
    ? await prisma.installation.findFirst({
        where: { id: pinned, userId: user.id },
        include: { product: true },
      })
    : null;

  const chatInput = pinnedInstallation
    ? `[Product: ${pinnedInstallation.product.title}] ${task}`
    : task;

  const thread = await prisma.thread.create({
    data: {
      userId: user.id,
      title: titleFor(task),
      messages: { create: [{ role: "USER", body: task }] },
    },
  });

  const output = await askOrchestrator(user.id, chatInput);

  await prisma.message.create({
    data: { threadId: thread.id, role: "ASSISTANT", body: output },
  });

  revalidatePath("/", "layout");
  redirect(`/tasks/${thread.id}`);
}

/** Re-runs after the user has supplied what the validator asked for. */
export async function provideInputs(formData: FormData) {
  const user = await requireUser();
  const runId = String(formData.get("runId") ?? "");

  const previous = await prisma.run.findFirst({
    where: { id: runId, userId: user.id },
    include: { product: true },
  });
  if (!previous) return;

  const args: Record<string, unknown> = {};
  for (const field of fields(previous.product)) {
    const value = formData.get(field.name);
    if (value !== null && String(value).length > 0) {
      args[field.name] =
        field.type === "number" ? Number(value) : String(value);
    }
  }

  const run = await executeRun({
    user,
    installationId: previous.installationId,
    args,
    threadId: previous.threadId ?? undefined,
  });

  if (previous.threadId) {
    await prisma.message.create({
      data: {
        threadId: previous.threadId,
        role: "ASSISTANT",
        runId: run?.id,
        body:
          run?.result === "SUCCESS"
            ? "Thanks — that was everything it needed. The run is done."
            : "Still missing something. Have a look below.",
      },
    });
    revalidatePath(`/tasks/${previous.threadId}`);
  }
}

/** The Run button in My workspace. Opens a thread so the result has a home. */
export async function runFromWorkspace(formData: FormData) {
  const user = await requireUser();
  const installationId = String(formData.get("installationId") ?? "");

  const installation = await prisma.installation.findFirst({
    where: { id: installationId, userId: user.id },
    include: { product: true },
  });
  if (!installation) return;

  const thread = await prisma.thread.create({
    data: {
      userId: user.id,
      title: installation.product.title,
      messages: {
        create: [{ role: "USER", body: `Run ${installation.product.title}.` }],
      },
    },
  });

  const run = await executeRun({
    user,
    installationId: installation.id,
    args: {},
    threadId: thread.id,
  });

  await prisma.message.create({
    data: {
      threadId: thread.id,
      role: "ASSISTANT",
      runId: run?.id,
      body:
        run?.result === "SUCCESS"
          ? "Done."
          : run?.result === "INCOMPLETE"
            ? "It needs a few details first."
            : "It could not run.",
    },
  });

  revalidatePath("/", "layout");
  redirect(`/tasks/${thread.id}`);
}
