import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Uploaded CSVs are kept on disk (not just parsed and discarded) so a training_plans row
// can retain `rawFile` for re-parsing later — e.g. if we improve the column-alias table.
const UPLOAD_DIR = path.resolve(import.meta.dirname, "../../../uploads");

interface UploadMeta {
  userId: string;
  originalFilename: string;
  planStartDate?: string;
  createdAt: string;
}

async function ensureDir(): Promise<void> {
  await mkdir(UPLOAD_DIR, { recursive: true });
}

export function newUploadToken(): string {
  return randomBytes(16).toString("hex");
}

export function uploadCsvPath(token: string): string {
  return path.join(UPLOAD_DIR, `${token}.csv`);
}

function uploadMetaPath(token: string): string {
  return path.join(UPLOAD_DIR, `${token}.meta.json`);
}

export async function saveUpload(
  token: string,
  csvContent: string,
  meta: UploadMeta,
): Promise<void> {
  await ensureDir();
  await writeFile(uploadCsvPath(token), csvContent, "utf8");
  await writeFile(uploadMetaPath(token), JSON.stringify(meta), "utf8");
}

export async function loadUpload(
  token: string,
): Promise<{ csvContent: string; meta: UploadMeta } | null> {
  try {
    const [csvContent, metaRaw] = await Promise.all([
      readFile(uploadCsvPath(token), "utf8"),
      readFile(uploadMetaPath(token), "utf8"),
    ]);
    return { csvContent, meta: JSON.parse(metaRaw) as UploadMeta };
  } catch {
    return null;
  }
}
