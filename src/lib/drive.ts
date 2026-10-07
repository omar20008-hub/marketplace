import "server-only";
import { extractText, getDocumentProxy } from "unpdf";
import { extractOfficeText, OFFICE_TYPES, OfficeError } from "./office-text";
import { decodeText } from "./text-decode";

/**
 * The little of the Drive API the indexer needs: check a folder, walk it, and
 * read a file as text. Read-only by construction — the scope is drive.readonly
 * and nothing here writes.
 */

const API = "https://www.googleapis.com/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_CHARS = 2_000_000;
const MAX_DEPTH = 8;

export class DriveError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DriveError";
  }
  /** Google refused the token itself: the connection needs renewing, not retrying. */
  get auth() {
    return this.status === 401;
  }
  get notFound() {
    return this.status === 404;
  }
  get retryable() {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
}

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  /** Changes when the content does: md5 for binary files, modifiedTime for Google-native ones. */
  revision: string;
  webUrl: string | null;
  path: string;
  size: number | null;
};

async function call(token: string, url: string, attempt = 0): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  } catch (error) {
    throw new DriveError(`Drive request failed: ${(error as Error).message}`, 0);
  }
  if (response.ok) return response;
  if ((response.status === 429 || response.status >= 500) && attempt < 2) {
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    return call(token, url, attempt + 1);
  }
  throw new DriveError(`Drive answered ${response.status}.`, response.status);
}

async function json<T>(token: string, path: string, params: Record<string, string>): Promise<T> {
  const url = `${API}${path}?${new URLSearchParams({
    supportsAllDrives: "true",
    ...params,
  })}`;
  return (await call(token, url)).json() as Promise<T>;
}

export async function getFolder(token: string, folderId: string) {
  const file = await json<{ id: string; name: string; mimeType: string }>(
    token,
    `/files/${encodeURIComponent(folderId)}`,
    { fields: "id,name,mimeType" },
  );
  if (file.mimeType !== FOLDER) throw new DriveError("That is not a folder.", 400);
  return { id: file.id, name: file.name };
}

type Listed = {
  id: string;
  name: string;
  mimeType: string;
  md5Checksum?: string;
  modifiedTime?: string;
  webViewLink?: string;
  size?: string;
};

/** Every file under a folder, subfolders included, capped so one huge drive cannot swallow the queue. */
export async function listTree(
  token: string,
  folderId: string,
  { maxFiles = 2000 } = {},
): Promise<{ files: DriveFile[]; folders: string[]; truncated: boolean }> {
  const files: DriveFile[] = [];
  const folders: string[] = [folderId];
  let truncated = false;
  const queue: { id: string; path: string; depth: number }[] = [{ id: folderId, path: "", depth: 0 }];

  while (queue.length > 0) {
    const folder = queue.shift()!;
    let pageToken: string | undefined;
    do {
      const page = await json<{ files: Listed[]; nextPageToken?: string }>(token, "/files", {
        q: `'${folder.id}' in parents and trashed = false`,
        fields:
          "nextPageToken,files(id,name,mimeType,md5Checksum,modifiedTime,webViewLink,size)",
        pageSize: "1000",
        includeItemsFromAllDrives: "true",
        ...(pageToken ? { pageToken } : {}),
      });
      pageToken = page.nextPageToken;

      for (const item of page.files) {
        if (item.mimeType === FOLDER) {
          if (folder.depth < MAX_DEPTH) {
            folders.push(item.id);
            queue.push({
              id: item.id,
              path: folder.path ? `${folder.path}/${item.name}` : item.name,
              depth: folder.depth + 1,
            });
          }
          continue;
        }
        if (files.length >= maxFiles) {
          truncated = true;
          continue;
        }
        files.push({
          id: item.id,
          name: item.name,
          mimeType: item.mimeType,
          revision: item.md5Checksum ?? item.modifiedTime ?? "0",
          webUrl: item.webViewLink ?? null,
          path: folder.path,
          size: item.size ? Number(item.size) : null,
        });
      }
    } while (pageToken);
  }
  return { files, folders, truncated };
}

const NATIVE_EXPORTS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.presentation": "text/plain",
  // Drive exports only the first sheet as CSV.
  "application/vnd.google-apps.spreadsheet": "text/csv",
};
const PLAIN = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);

export function isReadable(mimeType: string): boolean {
  return (
    mimeType in NATIVE_EXPORTS || PLAIN.has(mimeType) || mimeType === "application/pdf" || OFFICE_TYPES.has(mimeType)
  );
}

/**
 * Scratch files that other tools leave in a folder: a `tmp_…` copy, an Office
 * lock file, a `.tmp`. They duplicate real files or hold nothing, and embedding
 * them spends quota the real files need.
 */
/** The reason recorded for a scratch file. */
export const TEMPORARY_FILE_REASON = "A temporary file, so it is not indexed.";

export function isTemporaryName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("tmp_") || name.startsWith("~$") || lower.endsWith(".tmp");
}

/** The reason recorded for a file of a type that cannot be read (also how a file waiting for a newly supported type is recognised). */
export const UNSUPPORTED_TYPE_REASON = "This file type cannot be read yet.";

/** Why a file is not indexed, or null when it is. */
export function skipReason(name: string, mimeType: string): string | null {
  if (isTemporaryName(name)) return TEMPORARY_FILE_REASON;
  if (!isReadable(mimeType)) return UNSUPPORTED_TYPE_REASON;
  return null;
}

export type FileText = { ok: true; text: string } | { ok: false; reason: string };

export async function readFileText(token: string, file: DriveFile): Promise<FileText> {
  const id = encodeURIComponent(file.id);
  if (!isReadable(file.mimeType)) {
    return { ok: false, reason: UNSUPPORTED_TYPE_REASON };
  }
  if (file.size !== null && file.size > MAX_DOWNLOAD_BYTES) {
    return { ok: false, reason: "The file is larger than 25 MB." };
  }

  let response: Response;
  const exportAs = NATIVE_EXPORTS[file.mimeType];
  if (exportAs) {
    response = await call(token, `${API}/files/${id}/export?mimeType=${encodeURIComponent(exportAs)}`);
  } else {
    response = await call(token, `${API}/files/${id}?alt=media&supportsAllDrives=true`);
  }

  if (file.mimeType === "application/pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(await response.arrayBuffer()));
    const { text } = await extractText(pdf, { mergePages: true });
    if (!text.trim()) return { ok: false, reason: "The PDF has no text layer (a scan?)." };
    return { ok: true, text: text.slice(0, MAX_TEXT_CHARS) };
  }

  if (OFFICE_TYPES.has(file.mimeType)) {
    let text: string;
    try {
      text = extractOfficeText(new Uint8Array(await response.arrayBuffer()), file.mimeType);
    } catch (error) {
      if (error instanceof OfficeError) return { ok: false, reason: error.message };
      throw error;
    }
    if (!text.trim()) return { ok: false, reason: "The file has no text in it." };
    return { ok: true, text: text.slice(0, MAX_TEXT_CHARS) };
  }

  const text = decodeText(new Uint8Array(await response.arrayBuffer())).slice(0, MAX_TEXT_CHARS);
  if (!text.trim()) return { ok: false, reason: "The file is empty." };
  return { ok: true, text };
}

// ------------------------------------------------------------ change feed

async function send(token: string, url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
  } catch (error) {
    throw new DriveError(`Drive request failed: ${(error as Error).message}`, 0);
  }
  if (!response.ok) throw new DriveError(`Drive answered ${response.status}.`, response.status);
  return response;
}

export async function getStartPageToken(token: string): Promise<string> {
  const { startPageToken } = await json<{ startPageToken: string }>(
    token,
    "/changes/startPageToken",
    {},
  );
  return startPageToken;
}

export type DriveChange = {
  fileId: string;
  removed: boolean;
  parents: string[];
  trashed: boolean;
};

/** Everything that changed since the token, and the token to continue from. */
export async function listChanges(
  token: string,
  pageToken: string,
): Promise<{ changes: DriveChange[]; nextToken: string }> {
  const changes: DriveChange[] = [];
  let cursor = pageToken;
  for (let guard = 0; guard < 50; guard++) {
    const page = await json<{
      changes: {
        fileId?: string;
        removed?: boolean;
        file?: { parents?: string[]; trashed?: boolean };
      }[];
      nextPageToken?: string;
      newStartPageToken?: string;
    }>(token, "/changes", {
      pageToken: cursor,
      pageSize: "1000",
      includeItemsFromAllDrives: "true",
      fields: "nextPageToken,newStartPageToken,changes(fileId,removed,file(parents,trashed))",
    });
    for (const change of page.changes) {
      if (!change.fileId) continue;
      changes.push({
        fileId: change.fileId,
        removed: change.removed === true,
        parents: change.file?.parents ?? [],
        trashed: change.file?.trashed === true,
      });
    }
    if (page.newStartPageToken) return { changes, nextToken: page.newStartPageToken };
    if (!page.nextPageToken) return { changes, nextToken: cursor };
    cursor = page.nextPageToken;
  }
  // A backlog this long is better served by a full listing than by paging on.
  return { changes, nextToken: cursor };
}

/** Asks Drive to POST to `address` whenever the account's change feed moves. */
export async function watchChanges(
  token: string,
  {
    pageToken,
    channelId,
    address,
    secret,
    expiresAt,
  }: { pageToken: string; channelId: string; address: string; secret: string; expiresAt: Date },
): Promise<{ resourceId: string; expiresAt: Date }> {
  const response = await send(
    token,
    `${API}/changes/watch?${new URLSearchParams({
      pageToken,
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    })}`,
    {
      method: "POST",
      body: JSON.stringify({
        id: channelId,
        type: "web_hook",
        address,
        token: secret,
        expiration: String(expiresAt.getTime()),
      }),
    },
  );
  const body = (await response.json()) as { resourceId: string; expiration?: string };
  return {
    resourceId: body.resourceId,
    // Drive may grant less than was asked for; what it says is what holds.
    expiresAt: body.expiration ? new Date(Number(body.expiration)) : expiresAt,
  };
}

export async function stopChannel(token: string, channelId: string, resourceId: string) {
  await send(token, "https://www.googleapis.com/drive/v3/channels/stop", {
    method: "POST",
    body: JSON.stringify({ id: channelId, resourceId }),
  });
}

// ---------------------------------------------------------- folder browsing

export type FolderEntry = { id: string; name: string };

/** Folders directly inside `parent` ("root" is My Drive, "shared" is Shared with me), by name. */
export async function listFolders(token: string, parent: string): Promise<FolderEntry[]> {
  const q =
    parent === "shared"
      ? `sharedWithMe = true and mimeType = '${FOLDER}' and trashed = false`
      : `'${parent.replace(/'/g, "")}' in parents and mimeType = '${FOLDER}' and trashed = false`;
  const out: FolderEntry[] = [];
  let pageToken: string | undefined;
  do {
    const page = await json<{ files: FolderEntry[]; nextPageToken?: string }>(token, "/files", {
      q,
      fields: "nextPageToken,files(id,name)",
      orderBy: "name_natural",
      pageSize: "200",
      includeItemsFromAllDrives: "true",
      ...(pageToken ? { pageToken } : {}),
    });
    out.push(...page.files);
    pageToken = page.nextPageToken;
  } while (pageToken && out.length < 1000);
  return out;
}

/**
 * A folder id from whatever the user pasted: the folder's link (any of the
 * shapes Drive produces) or the bare id. Null when it is neither.
 */
export function parseFolderInput(input: string): string | null {
  const text = input.trim();
  const fromUrl =
    /\/folders\/([A-Za-z0-9_-]{10,})/.exec(text) ?? /[?&]id=([A-Za-z0-9_-]{10,})/.exec(text);
  if (fromUrl) return fromUrl[1];
  return /^[A-Za-z0-9_-]{10,}$/.test(text) ? text : null;
}
