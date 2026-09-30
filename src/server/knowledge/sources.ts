import "server-only";
import { prisma } from "@/lib/db";
import { GOOGLE_DRIVE_CREDENTIAL } from "@/lib/google-oauth";
import { DriveError, getFolder } from "@/lib/drive";
import { getGoogleAccessToken } from "@/server/google-account";
import { knowledgeAvailable } from "./availability";
import { enqueue } from "./queue";

export type ConnectSourceResult =
  | { ok: true; sourceId: string; folderName: string }
  | { ok: false; error: string };

/** Points the platform at a Drive folder and starts the first sync. */
export async function createKnowledgeSource(
  userId: string,
  { accountId, folderId }: { accountId: string; folderId: string },
): Promise<ConnectSourceResult> {
  if (!(await knowledgeAvailable())) {
    return { ok: false, error: "Knowledge search is not available on this platform yet." };
  }

  const account = await prisma.connectedAccount.findFirst({
    where: { id: accountId, userId, credentialType: GOOGLE_DRIVE_CREDENTIAL },
  });
  if (!account || account.status !== "ACTIVE") {
    return { ok: false, error: "Connect your Google Drive first." };
  }

  let folder;
  try {
    folder = await getFolder(await getGoogleAccessToken(account.id), folderId);
  } catch (error) {
    if (error instanceof DriveError && (error.notFound || error.status === 400 || error.status === 403)) {
      return { ok: false, error: "That folder could not be opened with this Google account." };
    }
    return { ok: false, error: "Google Drive could not be reached. Try again in a moment." };
  }

  const source = await prisma.knowledgeSource.upsert({
    where: { userId_provider_folderId: { userId, provider: "gdrive", folderId: folder.id } },
    create: {
      userId,
      accountId: account.id,
      folderId: folder.id,
      folderName: folder.name,
    },
    update: { accountId: account.id, folderName: folder.name, status: "ACTIVE", lastError: null },
  });
  await enqueue("SYNC_SOURCE", source.id);
  return { ok: true, sourceId: source.id, folderName: folder.name };
}
