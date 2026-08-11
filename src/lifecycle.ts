// Per-service wake / sleep, bypassing the silent no-op in `supabase start`.
//
// Truth still comes from probing docker. This only start/stops containers that
// already exist — it never creates anything and never touches a volume.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Layout } from './layouts/types.ts';
import type { Container } from './probe.ts';

const exec = promisify(execFile);

/** Measured safe to stop. db / kong / rest / auth are never touched. */
export const SLEEPABLE_ROLES = new Set([
  'studio', 'pg_meta', 'inbucket', 'realtime', 'edge_runtime', 'storage',
]);

export type LifecycleTarget = {
  slot: number;
  projectId: string;
  name: string;
  role: string;
  state: Container['state'];
};

export type LifecyclePlan = {
  action: 'wake' | 'sleep';
  targets: LifecycleTarget[];
  /** Why something was skipped, in words a human can act on */
  skipped: string[];
};

export type PlanOpts = {
  layout: Layout;
  containers: Container[];
  /** Restrict to these slots; empty means every slot we can explain */
  slots?: number[];
  /** Restrict to these roles; empty means every non-running role for wake,
   *  every sleepable role for sleep */
  roles?: string[];
};

function roleOf(layout: Layout, c: Container): string | null {
  if (!c.projectId) return null;
  return layout.stack.roleFromContainer(c.name, c.projectId);
}

function slotOf(layout: Layout, c: Container): number | null {
  if (!c.projectId) return null;
  return layout.slotFromProjectId(c.projectId);
}

function matchesSlot(slot: number, filter?: number[]): boolean {
  return !filter || filter.length === 0 || filter.includes(slot);
}

function matchesRole(role: string, filter?: string[]): boolean {
  return !filter || filter.length === 0 || filter.includes(role);
}

/** Pick what to `docker start`: exists, and is not already running. */
export function planWake(opts: PlanOpts): LifecyclePlan {
  const { layout, containers, slots, roles } = opts;
  const targets: LifecycleTarget[] = [];
  const skipped: string[] = [];

  // Index existing roles per slot, so we can tell a named role apart from one
  // whose container is simply gone.
  const bySlot = new Map<number, { projectId: string; roles: Set<string> }>();
  for (const c of containers) {
    const slot = slotOf(layout, c);
    if (slot === null || !c.projectId) continue;
    if (!matchesSlot(slot, slots)) continue;
    let g = bySlot.get(slot);
    if (!g) {
      g = { projectId: c.projectId, roles: new Set() };
      bySlot.set(slot, g);
    }
    const role = roleOf(layout, c);
    if (role) g.roles.add(role);
  }

  for (const c of containers) {
    const slot = slotOf(layout, c);
    if (slot === null) continue;
    if (!matchesSlot(slot, slots)) continue;
    const role = roleOf(layout, c) ?? '?';
    if (!matchesRole(role, roles)) continue;
    if (c.state === 'running') {
      skipped.push(`SLOT=${slot} ${role} already running`);
      continue;
    }
    targets.push({
      slot,
      projectId: c.projectId!,
      name: c.name,
      role,
      state: c.state,
    });
  }

  // When --role names something whose container no longer exists, say so plainly:
  // docker start cannot help, the service has to be recreated.
  if (roles && roles.length > 0) {
    const slotList = slots && slots.length > 0 ? slots : [...bySlot.keys()];
    for (const slot of slotList) {
      const g = bySlot.get(slot);
      for (const role of roles) {
        if (g?.roles.has(role)) continue;
        const projectId = g?.projectId ?? layout.expect(slot).projectId;
        skipped.push(
          `SLOT=${slot} ${role} container does not exist (not stopped — gone); docker start cannot help. ` +
          `Recreate supabase_${role}_${projectId} from the owning worktree via supabase/lifecycle`,
        );
      }
    }
  }

  targets.sort((a, b) => a.slot - b.slot || a.role.localeCompare(b.role));
  return { action: 'wake', targets, skipped };
}

/**
 * Pick what to `docker stop`: running, and on the sleepable whitelist.
 * --role may name any role inside the whitelist. Anything outside it is always
 * refused — no flag can override that.
 */
export function planSleep(opts: PlanOpts): LifecyclePlan {
  const { layout, containers, slots, roles } = opts;
  const targets: LifecycleTarget[] = [];
  const skipped: string[] = [];

  if (roles?.some(r => !SLEEPABLE_ROLES.has(r))) {
    const bad = roles.filter(r => !SLEEPABLE_ROLES.has(r));
    return {
      action: 'sleep',
      targets: [],
      skipped: [`refused to stop non-sleepable roles: ${bad.join(', ')} (allowed: ${[...SLEEPABLE_ROLES].join(', ')})`],
    };
  }

  for (const c of containers) {
    const slot = slotOf(layout, c);
    if (slot === null) continue;
    if (!matchesSlot(slot, slots)) continue;
    const role = roleOf(layout, c);
    if (!role) continue;
    if (!SLEEPABLE_ROLES.has(role)) {
      if (roles?.includes(role)) skipped.push(`SLOT=${slot} ${role} not on the sleepable whitelist`);
      continue;
    }
    if (!matchesRole(role, roles)) continue;
    if (c.state !== 'running') {
      skipped.push(`SLOT=${slot} ${role} not running (${c.state})`);
      continue;
    }
    targets.push({
      slot,
      projectId: c.projectId!,
      name: c.name,
      role,
      state: c.state,
    });
  }

  targets.sort((a, b) => a.slot - b.slot || a.role.localeCompare(b.role));
  return { action: 'sleep', targets, skipped };
}

export async function applyPlan(plan: LifecyclePlan): Promise<{ ok: string[]; failed: { name: string; error: string }[] }> {
  if (plan.targets.length === 0) return { ok: [], failed: [] };
  const cmd = plan.action === 'wake' ? 'start' : 'stop';
  const names = plan.targets.map(t => t.name);
  try {
    await exec('docker', [cmd, ...names], { maxBuffer: 8 * 1024 * 1024 });
    return { ok: names, failed: [] };
  } catch {
    // On a batch failure, retry one by one so the report can name the culprit.
    // For wake, a `task AlreadyExists` gets one stop+start retry.
    const ok: string[] = [];
    const failed: { name: string; error: string }[] = [];
    for (const name of names) {
      try {
        await exec('docker', [cmd, name], { maxBuffer: 1024 * 1024 });
        ok.push(name);
      } catch (err: any) {
        const msg = (err.stderr || err.message || String(err)).trim().split('\n')[0];
        if (plan.action === 'wake' && /AlreadyExists/i.test(msg)) {
          try {
            await exec('docker', ['stop', '-t', '0', name], { maxBuffer: 1024 * 1024 }).catch(() => {});
            await exec('docker', ['start', name], { maxBuffer: 1024 * 1024 });
            ok.push(name);
            continue;
          } catch (err2: any) {
            failed.push({
              name,
              error:
                ((err2.stderr || err2.message || String(err2)).trim().split('\n')[0]) +
                ' — if the Docker task is wedged: docker rm ' + name + ', then recreate the service from its worktree',
            });
            continue;
          }
        }
        failed.push({ name, error: msg });
      }
    }
    return { ok, failed };
  }
}

/** Parse CLI arguments: a list of slot numbers plus --role a,b */
export function parseLifecycleArgs(args: string[]): {
  slots: number[];
  roles: string[];
  all: boolean;
  dryRun: boolean;
  json: boolean;
} {
  const slots: number[] = [];
  const roles: string[] = [];
  let all = false;
  let dryRun = false;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--all') all = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--json') json = true;
    else if (a === '--role' || a === '--roles') {
      const v = args[++i];
      if (!v) throw new Error(`${a} requires an argument, e.g. --role realtime,studio`);
      roles.push(...v.split(',').map(s => s.trim()).filter(Boolean));
    } else if (a.startsWith('--role=')) {
      roles.push(...a.slice(7).split(',').map(s => s.trim()).filter(Boolean));
    } else if (/^\d+$/.test(a)) {
      slots.push(Number(a));
    } else if (a === 'all') {
      all = true;
    } else if (a.startsWith('-')) {
      throw new Error(`unknown option ${a}`);
    } else {
      throw new Error(`cannot parse argument ${a} (expected a slot number, --all, --role or --dry-run)`);
    }
  }

  if (!all && slots.length === 0) {
    throw new Error('specify a slot number, or --all\n  e.g. slotyard wake 17\n       slotyard sleep --all --role studio');
  }

  return { slots: all ? [] : slots, roles, all, dryRun, json };
}
