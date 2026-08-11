import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AiPlanDraft } from "@run-far/shared";

const DRAFT_DIR = path.resolve(import.meta.dirname, "../../../uploads/ai-drafts");

interface DraftMeta {
  userId: string;
  brief: string | null;
  createdAt: string;
}

async function ensureDir(): Promise<void> {
  await mkdir(DRAFT_DIR, { recursive: true });
}

export function newDraftToken(): string {
  return randomBytes(16).toString("hex");
}

function draftPath(token: string): string {
  return path.join(DRAFT_DIR, `${token}.json`);
}

function draftMetaPath(token: string): string {
  return path.join(DRAFT_DIR, `${token}.meta.json`);
}

export async function saveAiDraft(
  token: string,
  draft: AiPlanDraft,
  meta: DraftMeta,
): Promise<void> {
  await ensureDir();
  await writeFile(draftPath(token), JSON.stringify(draft), "utf8");
  await writeFile(draftMetaPath(token), JSON.stringify(meta), "utf8");
}

export async function loadAiDraft(
  token: string,
): Promise<{ draft: AiPlanDraft; meta: DraftMeta } | null> {
  try {
    const [draftRaw, metaRaw] = await Promise.all([
      readFile(draftPath(token), "utf8"),
      readFile(draftMetaPath(token), "utf8"),
    ]);
    return {
      draft: JSON.parse(draftRaw) as AiPlanDraft,
      meta: JSON.parse(metaRaw) as DraftMeta,
    };
  } catch {
    return null;
  }
}
