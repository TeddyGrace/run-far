import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { ScheduleChangeProposal } from "@run-far/shared";

const PROPOSAL_DIR = path.resolve(import.meta.dirname, "../../../uploads/ai-proposals");

interface ProposalMeta {
  userId: string;
  createdAt: string;
}

async function ensureDir(): Promise<void> {
  await mkdir(PROPOSAL_DIR, { recursive: true });
}

export function newProposalToken(): string {
  return randomBytes(16).toString("hex");
}

function proposalPath(token: string): string {
  return path.join(PROPOSAL_DIR, `${token}.json`);
}

function proposalMetaPath(token: string): string {
  return path.join(PROPOSAL_DIR, `${token}.meta.json`);
}

export async function saveProposal(
  token: string,
  proposal: ScheduleChangeProposal,
  meta: ProposalMeta,
): Promise<void> {
  await ensureDir();
  await writeFile(proposalPath(token), JSON.stringify(proposal), "utf8");
  await writeFile(proposalMetaPath(token), JSON.stringify(meta), "utf8");
}

export async function loadProposal(
  token: string,
): Promise<{ proposal: ScheduleChangeProposal; meta: ProposalMeta } | null> {
  try {
    const [proposalRaw, metaRaw] = await Promise.all([
      readFile(proposalPath(token), "utf8"),
      readFile(proposalMetaPath(token), "utf8"),
    ]);
    return {
      proposal: JSON.parse(proposalRaw) as ScheduleChangeProposal,
      meta: JSON.parse(metaRaw) as ProposalMeta,
    };
  } catch {
    return null;
  }
}

export async function deleteProposal(token: string): Promise<void> {
  await Promise.all([
    unlink(proposalPath(token)).catch(() => {}),
    unlink(proposalMetaPath(token)).catch(() => {}),
  ]);
}
