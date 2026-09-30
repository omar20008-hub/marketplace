import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { DriveError, getFolder, listFolders, parseFolderInput } from "@/lib/drive";
import { GOOGLE_DRIVE_CREDENTIAL } from "@/lib/google-oauth";
import { getGoogleAccessToken } from "@/server/google-account";

/**
 * The folder browser's data: the folders inside one folder of the signed-in
 * user's own Drive. The Drive token stays on the server — the browser sends a
 * parent id and gets names back, and never holds anything that could read files.
 *
 *   GET ?parent=root|shared|<folderId>   subfolders of that folder
 *   GET ?resolve=<link or id>            the folder a pasted link points to
 */
export async function GET(request: Request) {
  const user = await requireUser();
  const account = await prisma.connectedAccount.findFirst({
    where: { userId: user.id, credentialType: GOOGLE_DRIVE_CREDENTIAL, status: "ACTIVE" },
  });
  if (!account) return NextResponse.json({ error: "not_connected" }, { status: 409 });

  const url = new URL(request.url);
  try {
    const token = await getGoogleAccessToken(account.id);

    const resolve = url.searchParams.get("resolve");
    if (resolve !== null) {
      const id = parseFolderInput(resolve);
      if (!id) return NextResponse.json({ error: "not_a_folder" }, { status: 400 });
      return NextResponse.json({ folder: await getFolder(token, id) });
    }

    const parent = url.searchParams.get("parent") ?? "root";
    if (parent !== "root" && parent !== "shared" && !/^[A-Za-z0-9_-]{10,}$/.test(parent)) {
      return NextResponse.json({ error: "bad_parent" }, { status: 400 });
    }
    return NextResponse.json({ folders: await listFolders(token, parent) });
  } catch (error) {
    if (error instanceof DriveError && (error.notFound || error.status === 400 || error.status === 403)) {
      return NextResponse.json({ error: "not_a_folder" }, { status: 404 });
    }
    return NextResponse.json({ error: "drive_unavailable" }, { status: 502 });
  }
}

export const dynamic = "force-dynamic";
