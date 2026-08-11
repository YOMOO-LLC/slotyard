// The third view: what the repo *declares*. Only ever compared against probed
// reality — never treated as truth itself.
//
// Two declarations, very different reliability:
//   project_id in config.toml — what the supabase CLI actually reads. This is
//                               the effective config, so ownership is decided by it.
//   .wt-slot                  — the project's own registry. This is intent.
//                               Measured 32% accurate on a real machine.
// The two disagreeing is itself a finding.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Layout } from './layouts/types.ts';
import type { Worktree } from './probe.ts';

export type Declaration = {
  worktree: Worktree;
  /** From config.toml — the effective value, and the basis for ownership */
  effective: { projectId: string; slot: number | null } | null;
  /** From .wt-slot — intent only */
  intent: { slot: number; ports: Record<string, number>; projectId?: string } | null;
  /** Registry file exists but no slot could be parsed out of it (e.g. empty) */
  intentBroken: boolean;
};

export async function readDeclarations(worktrees: Worktree[], layout: Layout): Promise<Declaration[]> {
  return Promise.all(worktrees.map(async (worktree) => {
    const [effective, intentRaw] = await Promise.all([
      readEffective(worktree.path, layout),
      readMaybe(join(worktree.path, layout.registry.file)),
    ]);
    const intent = intentRaw === null ? null : layout.registry.parse(intentRaw);
    return {
      worktree,
      effective,
      intent,
      intentBroken: intentRaw !== null && intent === null,
    };
  }));
}

async function readEffective(root: string, layout: Layout) {
  const content = await readMaybe(join(root, layout.configPath));
  if (content === null) return null;
  const m = /^\s*project_id\s*=\s*"([^"]+)"/m.exec(content);
  if (!m) return null;
  return { projectId: m[1], slot: layout.slotFromProjectId(m[1]) };
}

async function readMaybe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
