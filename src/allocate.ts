// The allocation decision: answer "which slot is genuinely free right now" and
// write nothing.
//
// Why this is worth lifting out of a shell script. A typical hand-rolled
// allocator decides occupancy from its registry file alone, and short-circuits
// with "the file already exists, so reuse it and skip validation". Observed
// consequence on a real machine: one slot was handed out, then handed out again
// a week later. Two worktrees, one project_id, one database, no error anywhere.
// That is precisely what "never treat a declaration file as truth" is about.
//
// Occupancy here comes from probing: container labels, plus the project_id in
// each worktree's config.toml. The same truth doctor uses — so the allocator and
// the checkup can never disagree with each other.

import type { Layout } from './layouts/types.ts';
import type { Container } from './probe.ts';
import type { Declaration } from './declarations.ts';

export type AllocInput = {
  layout: Layout;
  mainRoot: string;
  containers: Container[];
  declarations: Declaration[];
  /** port -> who holds it. Ports are machine-wide while the slot space is
   *  per-project; without reconciling the two, the allocator hands out a number
   *  whose ports are already taken. */
  blockedPorts: Map<number, string>;
  /** Who is asking — used to recognise "this slot was already mine" */
  cwd: string;
  /** Whatever number the caller's registry file claims. A hint only, never
   *  accepted as proof of ownership. */
  claimed?: number;
};

const isMine = (path: string, cwd: string) => path === cwd;

/** True when every probed workDir on this slot sits outside this repo's roots.
 *  No workDir at all is unknown, not foreign — keep today's idempotent reuse.
 *  Path boundaries match ownerRoot, so `/wt/alpha` does not claim `/wt/alpha-2`. */
function slotHeldByForeignClone(input: AllocInput, slot: number): boolean {
  const { layout, mainRoot, containers, declarations } = input;
  const dirs = containers
    .filter(c => c.projectId != null && layout.slotFromProjectId(c.projectId) === slot)
    .map(c => c.workDir)
    .filter((d): d is string => typeof d === 'string' && d.length > 0);
  if (dirs.length === 0) return false;
  const roots = [mainRoot, ...declarations.map(d => d.worktree.path)];
  return dirs.every(d => !roots.includes(ownerRoot(d, roots)));
}

/**
 * Which worktree a cwd belongs to. Callers are rarely standing at a worktree
 * root — config.toml itself usually lives a few directories down.
 *
 * Must take the LONGEST matching prefix. Worktrees are often nested inside the
 * main repo, and a first-match rule would attribute every one of them to the
 * main repo, hand them all slot 0, and pile them onto the default project_id —
 * which is the exact critical this tool exists to catch.
 *
 * Compare up to a path separator, or `/wt/alpha` would claim `/wt/alpha-2`.
 */
export function ownerRoot(cwd: string, roots: string[]): string {
  let best = '';
  for (const r of roots) {
    const under = cwd === r || cwd.startsWith(r.endsWith('/') ? r : r + '/');
    if (under && r.length > best.length) best = r;
  }
  return best || cwd;
}

/**
 * Slots already taken. Both sources are probed, and neither is the registry file:
 * - it has containers (stopped ones count — their volumes are still attached, so
 *   handing the slot out would silently share a database)
 * - some worktree's config.toml points at it (the value the supabase CLI reads)
 */
export function occupiedSlots(input: AllocInput): Set<number> {
  const { layout, containers, declarations, cwd } = input;
  const occ = new Set<number>();
  for (const c of containers) {
    if (!c.projectId) continue;
    const slot = layout.slotFromProjectId(c.projectId);
    if (slot !== null && slot > 0) occ.add(slot);
  }
  for (const d of declarations) {
    const slot = d.effective?.slot;
    if (slot != null && slot > 0 && !isMine(d.worktree.path, cwd)) occ.add(slot);
  }
  return occ;
}

/**
 * Slots whose expected ports are already held by something.
 *
 * Why this has to be checked separately: occupiedSlots can only see containers
 * this layout explains, and declarations from this repo. A port is neither — a
 * zombie dev server or another project's cold stack can be sitting on it.
 * Measured: with a process holding one port, the allocator still handed out that
 * slot, and the failure only surfaced later when the stack tried to start.
 */
export function portBlockedSlots(
  input: AllocInput,
): Map<number, { port: number; role: string; by: string }> {
  const { layout, blockedPorts } = input;
  const blocked = new Map<number, { port: number; role: string; by: string }>();
  if (blockedPorts.size === 0) return blocked;
  for (let slot = 1; slot <= layout.maxSlot; slot++) {
    for (const [role, port] of Object.entries(layout.expect(slot).ports)) {
      const by = blockedPorts.get(port);
      if (by !== undefined && !blocked.has(slot)) blocked.set(slot, { port, role, by });
    }
  }
  return blocked;
}

/**
 * Returns a usable slot, or null when everything is taken. The main repo is
 * always 0.
 *
 * THIS CANNOT PREVENT A RACE. There is a window between reading here and the
 * caller writing config.toml, so two worktrees created at the same moment can
 * still receive the same number. Real mutual exclusion would mean writing state
 * from here, which is a different level of trust. Callers that create worktrees
 * in parallel must hold a lock across BOTH the request and the write — locking
 * only this call achieves nothing, because the window is between the two.
 *
 * doctor's collision check therefore remains the safety net, not redundancy.
 */
export function chooseSlot(input: AllocInput): number | null {
  const { layout, mainRoot, declarations, cwd, claimed } = input;
  if (cwd === mainRoot) return 0;

  const occ = occupiedSlots(input);

  // Idempotence: if my own config.toml already holds a number and nobody ELSE
  // in THIS repo declares it, hand back the same one. Containers with no
  // workDir still count as mine — unknown is not foreign. But two clones of
  // the same project_id share one docker name: if every workDir on this slot
  // sits outside our roots, returning mine would keep handing out the other
  // clone's slot and silently share its database. Fall through so occupiedSlots
  // (containers still count) hands out a different number.
  const mine = declarations.find(d => isMine(d.worktree.path, cwd))?.effective?.slot;
  const declaredByOthers = new Set(
    declarations
      .filter(d => !isMine(d.worktree.path, cwd) && d.effective?.slot != null)
      .map(d => d.effective!.slot!),
  );
  // The idempotent path skips the port check: my own stack is of course holding
  // my own ports.
  if (mine != null && mine > 0 && !declaredByOthers.has(mine) && !slotHeldByForeignClone(input, mine)) {
    return mine;
  }

  const blocked = portBlockedSlots(input);
  const free = (s: number) => !occ.has(s) && !blocked.has(s);

  // `claimed` only means "try this one first"; if it is taken we move on. That
  // second half is the step hand-rolled allocators tend to skip.
  if (claimed != null && claimed > 0 && free(claimed)) return claimed;

  for (let s = 1; s <= layout.maxSlot; s++) if (free(s)) return s;
  return null;
}
