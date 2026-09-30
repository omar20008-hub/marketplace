import "server-only";
import { extractText, getDocumentProxy } from "unpdf";

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
): Promise<{ files: DriveFile[]; truncated: boolean }> {
  const files: DriveFile[] = [];
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
  return { files, truncated };
}

const NATIVE_EXPORTS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.presentation": "text/plain",
  // Drive exports only the first sheet as CSV.
  "application/vnd.google-apps.spreadsheet": "text/csv",
};
const PLAIN = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);

export function isReadable(mimeType: string): boolean {
  return mimeType in NATIVE_EXPORTS || PLAIN.has(mimeType) || mimeType === "application/pdf";
}

export type FileText = { ok: true; text: string } | { ok: false; reason: string };

export async function readFileText(token: string, file: DriveFile): Promise<FileText> {
  const id = encodeURIComponent(file.id);
  if (!isReadable(file.mimeType)) {
    return { ok: false, reason: "This file type cannot be read yet." };
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

  const text = (await response.text()).slice(0, MAX_TEXT_CHARS);
  if (!text.trim()) return { ok: false, reason: "The file is empty." };
  return { ok: true, text };
}
