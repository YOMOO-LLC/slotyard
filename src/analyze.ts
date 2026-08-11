// The three-way join, and the checks that run on it.
//
// Every finding is a residue of that join — a place where observation, effective
// config and declared intent fail to line up.

import { dirname } from 'node:path';
import type { Layout } from './layouts/types.ts';
import type { Container, Listener, Worktree } from './probe.ts';
import type { Declaration } from './declarations.ts';
import { SLEEPABLE_ROLES } from './lifecycle.ts';

export type Confidence = 'certain' | 'likely' | 'uncertain';

export type Finding = {
  severity: 'critical' | 'warning' | 'info';
  kind: string;
  slot?: number;
  message: string;
  evidence: string[];
  confidence: Confidence;
  suggestion?: string;
};

export type SlotView = {
  slot: number;
  projectId: string;
  containers: Container[];
  listeners: Listener[];
  claimants: Declaration[];
  volumes: string[];
  running: boolean;
  /** When this slot has containers running, the roles that are exited —
   *  either deliberately asleep, or crashed. */
  sleeping: string[];
  memMiB: number | null;
  cpuPct: number | null;
  uptime: string;
};

export type Identity = { projectId: string; jwtFingerprint: string; siteUrl: string };

export type Input = {
  layout: Layout;
  mainRoot: string;
  worktrees: Worktree[];
  containers: Container[];
  listeners: Listener[];
  declarations: Declaration[];
  identities: Identity[];
  volumes: string[];
};

export function analyze(input: Input): { slots: SlotView[]; findings: Finding[] } {
  const { layout, declarations, containers, listeners, volumes } = input;

  // ── The three-way join. Slot number is the key. ────────────────
  const slots = new Map<number, SlotView>();
  const view = (slot: number): SlotView => {
    let v = slots.get(slot);
    if (!v) {
      v = {
        slot, projectId: layout.expect(slot).projectId,
        containers: [], listeners: [], claimants: [], volumes: [],
        running: false, sleeping: [], memMiB: null, cpuPct: null, uptime: '',
      };
      slots.set(slot, v);
    }
    return v;
  };

  for (const c of containers) {
    if (!c.projectId) continue;
    const slot = layout.slotFromProjectId(c.projectId);
    if (slot === null) continue;
    view(slot).containers.push(c);
  }
  // Declarations join first, listeners after: a port alone must never conjure
  // up a phantom slot row.
  for (const d of declarations) {
    if (d.effective?.slot != null) view(d.effective.slot).claimants.push(d);
  }
  for (const l of listeners) {
    const hit = layout.slotFromPort(l.port);
    if (!hit) continue;
    const existing = slots.get(hit.slot);
    if (existing) existing.listeners.push(l);
  }

  for (const v of slots.values()) {
    const live = v.containers.filter(c => c.state === 'running');
    const dead = v.containers.filter(c => c.state === 'exited' || c.state === 'other');
    v.running = live.length > 0;
    v.sleeping = v.running
      ? dead.map(c => layout.stack.roleFromContainer(c.name, v.projectId) ?? c.name).sort()
      : [];
    v.volumes = volumes.filter(name => layout.stack.volumeBelongsTo(name, v.projectId));
    const mems = live.map(c => c.memMiB).filter((n): n is number => n != null);
    v.memMiB = mems.length ? mems.reduce((a, b) => a + b, 0) : null;
    const cpus = live.map(c => c.cpuPct).filter((n): n is number => n != null);
    v.cpuPct = cpus.length ? cpus.reduce((a, b) => a + b, 0) : null;
    v.uptime = live[0]?.uptime ?? '';
  }

  // Drop rows with nothing but dead containers, no declaration and no volume
  const kept = [...slots.values()].filter(v =>
    v.running || v.claimants.length > 0 || v.volumes.length > 0,
  );
  const keptMap = new Map(kept.map(v => [v.slot, v]));
  return {
    slots: kept.sort((a, b) => a.slot - b.slot),
    findings: check(input, keptMap),
  };
}

/** Data-plane ports: connecting to the wrong one crosses databases or apps.
 *  The rest (studio, metro, …) cannot affect data correctness. */
const DATA_PORT_ROLES = new Set(['db', 'api', 'web']);

function foreignPortSeverity(role: string): Finding['severity'] {
  return DATA_PORT_ROLES.has(role) ? 'warning' : 'info';
}

function foreignPortEvidence(role: string, l: Listener): string[] {
  const base = [`${l.command} (pid ${l.pid})`, l.cwd ? `cwd ${l.cwd}` : 'cwd unknown'];
  if (role === 'db' || role === 'api') base.push('will connect to the wrong database');
  else if (role === 'web') base.push('will reach the wrong app');
  else if (role === 'metro') base.push('metro carries no data — usually safe to ignore');
  else base.push(`${role} does not affect data correctness — usually safe to ignore`);
  return base;
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : root + '/');
}

/** Parent directories shared by several worktrees */
function familyHubs(mainRoot: string, worktrees: Worktree[]): string[] {
  const counts = new Map<string, number>();
  for (const w of worktrees) {
    const p = dirname(w.path);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const hubs = [mainRoot];
  for (const [p, n] of counts) if (n >= 2) hubs.push(p);
  return hubs;
}

type ListenerHome = 'worktree' | 'family' | 'foreign' | 'unknown';

/** cwd is often unavailable from lsof. Fall back to reading a project root out
 *  of the command line, e.g. `node /abs/path/node_modules/...`. */
function listenerPathHint(l: Listener): string | null {
  if (l.cwd) return l.cwd;
  // Any absolute path
  const m = /(\/(?:Users|home|private\/tmp|tmp|var\/folders|opt)[^\s:]*)/.exec(l.command)
    ?? /(\/[^\s:]+)/.exec(l.command);
  if (!m) return null;
  let p = m[1];
  // Cut at a common project boundary so trailing flags do not get glued on
  const cut = p.search(/\/(node_modules|\.bin|apps)\b/);
  if (cut >= 0) p = p.slice(0, cut);
  return p || null;
}

function listenerHome(path: string | null, mainRoot: string, worktrees: Worktree[]): ListenerHome {
  if (!path) return 'unknown';
  if (isUnder(path, mainRoot) || worktrees.some(w => isUnder(path, w.path))) return 'worktree';
  if (familyHubs(mainRoot, worktrees).some(h => isUnder(path, h))) return 'family';
  return 'foreign';
}

function isEphemeralPath(p: string): boolean {
  return /^\/(private\/)?(tmp|var\/folders)\//.test(p);
}

/** A worktree that will realistically be started in parallel: the directory
 *  exists, git does not consider it prunable, and it is not under a temp dir. */
function isActionableWorktree(w: Worktree): boolean {
  return w.exists && !w.prunable && !isEphemeralPath(w.path);
}

/**
 * A paste-ready reassignment command.
 *
 * Assumes the project's own lifecycle script, where `up` writes the registry
 * file, rewrites config.toml and starts the stack. Such scripts are usually
 * idempotent by reusing the existing registry file — which means a collision has
 * to remove it first, or the same number comes back.
 */
function reassignCmd(absPath: string): string {
  return `cd ${absPath} && rm .wt-slot && tools/wt-supabase-lifecycle.sh up`;
}

/** An unallocated worktree usually has no registry file at all, so telling the
 *  user to remove one would just confuse. Plain `up` allocates. */
function assignCmd(absPath: string): string {
  return `cd ${absPath} && tools/wt-supabase-lifecycle.sh up`;
}

function collisionSuggestion(
  claimants: Declaration[],
  active: boolean,
  name: (p: string) => string,
): string {
  // Ownership cannot be traced back from a container, so there is no better
  // basis than a stable one: keep the lexicographically first path either way.
  const sorted = [...claimants].sort((a, b) => a.worktree.path.localeCompare(b.worktree.path));
  const keep = sorted[0];
  const rest = sorted.slice(1);
  const basis = active
    ? 'containers are running (ownership cannot be traced back from a container, so the lexicographically first path wins)'
    : 'none running, keeping the lexicographically first path';
  const lines = [
    `Fix (keep ${name(keep.worktree.path)}, reassign the rest; basis: ${basis}):`,
    ...rest.map(d => `   ${reassignCmd(d.worktree.path)}`),
    '   (up starts the stack; add WT_SKIP_SUPABASE=1 to allocate only)',
  ];
  return lines.join('\n');
}

function unassignedSuggestion(claimants: Declaration[]): string {
  // Push temp directories to the back: they are usually abandoned staging and
  // should not fill the first lines of a paste-ready list.
  const sorted = [...claimants].sort((a, b) => {
    const ae = isEphemeralPath(a.worktree.path) ? 1 : 0;
    const be = isEphemeralPath(b.worktree.path) ? 1 : 0;
    if (ae !== be) return ae - be;
    return a.worktree.path.localeCompare(b.worktree.path);
  });
  const lines = [
    'Fix (run lifecycle up in each worktree to allocate a slot; this starts the stack):',
    ...sorted.slice(0, 6).map(d => `   ${assignCmd(d.worktree.path)}`),
    ...(sorted.length > 6
      ? [`   …and ${sorted.length - 6} more, same command: tools/wt-supabase-lifecycle.sh up`]
      : []),
    '   (add WT_SKIP_SUPABASE=1 to allocate without starting; usually no .wt-slot, so no rm needed)',
  ];
  return lines.join('\n');
}

/**
 * This is data, not garbage. So the inspect command comes first, deletion comes
 * after, and the ORDER IS FIXED: containers first, volumes last.
 *
 * Those exited containers are the only thing currently protecting these volumes
 * from a `docker volume prune`. Doing it the other way round dismantles the
 * protection first. slotyard executes none of these itself.
 *
 * Filter by label rather than listing names: a truncated list pastes into a
 * command that does the wrong thing.
 */
function orphanSuggestion(v: SlotView, labelKey: string): string {
  const sel = `--filter label=${labelKey}=${v.projectId}`;
  return [
    'slotyard never deletes. Check age first:',
    `   docker volume inspect ${v.volumes[0]} --format '{{.CreatedAt}}'`,
    'If it really is abandoned — containers first, volumes last:',
    `   docker rm $(docker ps -aq ${sel})`,
    `   docker volume rm ${v.volumes.join(' ')}`,
  ].join('\n');
}

function check(input: Input, slots: Map<number, SlotView>): Finding[] {
  const { layout, mainRoot, worktrees, declarations, listeners, identities, volumes } = input;
  const out: Finding[] = [];
  const name = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
  const slotHasVolumes = (slot: number) => {
    const projectId = layout.expect(slot).projectId;
    return volumes.some(v => layout.stack.volumeBelongsTo(v, projectId));
  };

  // ── 1. Collision: several worktrees' effective config point at one slot ──
  for (const v of slots.values()) {
    if (v.claimants.length < 2) continue;

    // Slot 0 is special. Allocation scripts leave config.toml untouched for it,
    // so every worktree that never went through allocation sits on the committed
    // default project_id. The main repo using slot 0 is legitimate; everything
    // else on it is simply unallocated.
    const raw = v.slot === 0
      ? v.claimants.filter(c => c.worktree.path !== mainRoot)
      : v.claimants;
    if (raw.length < 2) continue;

    const isDefault = v.slot === 0;
    const active = v.running;

    // Noise control: leftovers under /tmp, deleted directories and prunable
    // entries must not be what pushes a report to critical and exit 2. Only
    // worktrees that would realistically be started count as actionable.
    if (isDefault) {
      const actionable = raw.filter(c => isActionableWorktree(c.worktree));
      const ignored = raw.length - actionable.length;
      if (actionable.length >= 2) {
        out.push({
          severity: 'critical',
          kind: 'unassigned-default',
          slot: 0,
          message: `${actionable.length} worktrees using the unallocated default project_id`,
          evidence: [
            `project_id = ${v.projectId}`,
            ...actionable.slice(0, 8).map(c => `  ${name(c.worktree.path)}`),
            ...(actionable.length > 8 ? [`  …and ${actionable.length - 8} more`] : []),
            ...(ignored > 0
              ? [`${ignored} ephemeral/stale worktree${s(ignored)} excluded (not counted toward critical)`]
              : []),
          ],
          confidence: 'certain',
          suggestion: unassignedSuggestion(actionable),
        });
      } else if (raw.length >= 2) {
        out.push({
          severity: 'info',
          kind: 'unassigned-noise',
          slot: 0,
          message: `${raw.length} ephemeral/stale worktrees left on the default project_id (demoted, no exit 2)`,
          evidence: raw.slice(0, 6).map(c => {
            const w = c.worktree;
            const why = !w.exists ? 'missing' : w.prunable ? 'prunable' : isEphemeralPath(w.path) ? 'ephemeral' : '?';
            return `  ${name(w.path)} (${why})`;
          }),
          confidence: 'certain',
        });
      }
      continue;
    }

    // Non-zero: a real collision — several worktrees claiming one slot
    out.push({
      severity: active ? 'critical' : 'warning',
      kind: 'collision',
      slot: v.slot,
      message: `SLOT=${v.slot} claimed by ${raw.length} worktrees at once`,
      evidence: [
        `project_id = ${v.projectId}`,
        ...raw.slice(0, 8).map(c => `  ${name(c.worktree.path)}`),
        ...(raw.length > 8 ? [`  …and ${raw.length - 8} more`] : []),
      ],
      confidence: 'certain',
      suggestion: collisionSuggestion(raw, active, name),
    });
  }

  // ── 2. Unclaimed: running, but no worktree's config points at it ────
  for (const v of slots.values()) {
    if (!v.running || v.claimants.length > 0) continue;
    const live = v.containers.filter(c => c.state === 'running');
    out.push({
      severity: 'warning',
      kind: 'unclaimed',
      slot: v.slot,
      message: `SLOT=${v.slot} has ${live.length} container${s(live.length)} running but no worktree claims it`,
      evidence: [
        `project_id = ${v.projectId}`,
        `up ${v.uptime}${v.memMiB ? ` · ${fmtMem(v.memMiB)}` : ''}`,
        'the worktree was most likely deleted',
      ],
      confidence: 'certain',
    });
  }

  // ── 2a. Orphaned data: not running, unclaimed, volumes still there ──
  //
  // This is the one class docker can never work out for itself. It only does
  // reference counting, and these volumes are referenced by their own exited
  // containers — so as far as docker is concerned they are in use, and prune will
  // never touch them. docker also cannot see git, which means it cannot tell a
  // cold environment you will resume tomorrow from the remains of a worktree
  // deleted three weeks ago. To docker the two are identical.
  //
  // Making that distinction is the reason this tool exists, so a stopped stack
  // has to be reported too.
  for (const v of slots.values()) {
    if (v.running || v.claimants.length > 0 || v.volumes.length === 0) continue;
    const since = v.containers.find(c => c.status)?.status ?? '';
    out.push({
      severity: 'warning',
      kind: 'orphan-data',
      slot: v.slot,
      message: `SLOT=${v.slot} still holds ${v.volumes.length} volume${s(v.volumes.length)} but no worktree claims it`,
      evidence: [
        `project_id = ${v.projectId}`,
        ...(since ? [`containers ${since}`] : []),
        ...v.volumes.slice(0, 4).map(n => `  ${n}`),
        ...(v.volumes.length > 4 ? [`  …and ${v.volumes.length - 4} more`] : []),
        'docker sees these as in-use (their own exited containers reference them) and will never prune them',
      ],
      confidence: 'certain',
      suggestion: orphanSuggestion(v, layout.stack.labelKey),
    });
  }

  // ── 2b. Half-asleep stack: some containers running, some exited ─────
  // `supabase start` is a silent no-op when only some containers are stopped, so
  // this has to be surfaced explicitly or the user never learns why.
  for (const v of slots.values()) {
    if (!v.running || v.sleeping.length === 0) continue;
    const coreDown = v.sleeping.filter(r => !SLEEPABLE_ROLES.has(r));
    out.push({
      severity: coreDown.length > 0 ? 'warning' : 'info',
      kind: 'partial-stack',
      slot: v.slot,
      message: `SLOT=${v.slot} has ${v.sleeping.length} service${s(v.sleeping.length)} down: ${v.sleeping.join(', ')}`,
      evidence: [
        `project_id = ${v.projectId}`,
        ...(coreDown.length > 0
          ? [`non-sleepable roles are down too: ${coreDown.join(', ')} (looks like a failure, not sleep)`]
          : ['these roles were measured safe to stop (sleep candidates)']),
        'supabase start can silently no-op when some containers are stopped — it will not bring these back',
      ],
      confidence: 'certain',
      suggestion: `slotyard wake ${v.slot}` +
        (v.sleeping.length === 1 ? ` --role ${v.sleeping[0]}` : ''),
    });
  }

  // ── 3. Cold vs phantom: declared, but nothing is running ────────────
  // cold    = volumes still there. Data survived the stop and `up` will reuse it.
  //           Perfectly normal, so info.
  // phantom = a declaration with no volumes at all. Nothing to lose, also info.
  const idleDecls = declarations.filter(d =>
    d.intent && !(slots.get(d.intent.slot)?.running));
  const colds = idleDecls.filter(d => slotHasVolumes(d.intent!.slot));
  const phantoms = idleDecls.filter(d => !slotHasVolumes(d.intent!.slot));
  if (colds.length > 0) {
    out.push({
      severity: 'info',
      kind: 'cold',
      message: `${colds.length} environment${s(colds.length)} stopped but data kept — up will reuse them`,
      evidence: colds.slice(0, 10).map(d => `  ${name(d.worktree.path)} → SLOT=${d.intent!.slot}`),
      confidence: 'certain',
    });
  }
  if (phantoms.length > 0) {
    out.push({
      severity: 'info',
      kind: 'phantom',
      message: `${phantoms.length} declaration${s(phantoms.length)} point${phantoms.length === 1 ? 's' : ''} at neither containers nor data`,
      evidence: phantoms.slice(0, 10).map(d => `  ${name(d.worktree.path)} → SLOT=${d.intent!.slot}`),
      confidence: 'certain',
    });
  }

  // ── 4. Intent has drifted away from the effective config ────────────
  for (const d of declarations) {
    if (!d.intent || d.effective?.slot == null) continue;
    if (d.intent.slot === d.effective.slot) continue;
    out.push({
      severity: 'warning',
      kind: 'intent-drift',
      slot: d.effective.slot,
      message: `${name(d.worktree.path)}: declaration disagrees with the effective config`,
      evidence: [
        `.wt-slot says SLOT=${d.intent.slot}`,
        `config.toml says ${d.effective.projectId} (= SLOT ${d.effective.slot})`,
        'supabase CLI reads config.toml',
      ],
      confidence: 'certain',
    });
  }

  const broken = declarations.filter(d => d.intentBroken);
  if (broken.length > 0) {
    out.push({
      severity: 'info',
      kind: 'broken-registry',
      message: `${broken.length} ${layout.registry.file} file${s(broken.length)} exist${broken.length === 1 ? 's' : ''} but ${broken.length === 1 ? 'is' : 'are'} unparseable`,
      evidence: broken.slice(0, 6).map(d => `  ${name(d.worktree.path)}`),
      confidence: 'certain',
    });
  }

  // ── 5. Identity boundary. State facts only. ─────────────────────────
  // The downstream consequences are not yet pinned down by measurement, so this
  // reports what is true and stops there rather than telling a story.
  if (identities.length > 1) {
    const byFp = new Map<string, string[]>();
    for (const id of identities) {
      byFp.set(id.jwtFingerprint, [...(byFp.get(id.jwtFingerprint) ?? []), id.projectId]);
    }
    for (const [fp, pids] of byFp) {
      if (pids.length < 2) continue;
      const sites = [...new Set(identities.filter(i => pids.includes(i.projectId)).map(i => i.siteUrl))];
      out.push({
        severity: 'warning',
        kind: 'identity',
        message: `${pids.length} running environments share an identical JWT secret`,
        evidence: [
          `fingerprint ${fp}`,
          `site_url: ${sites.join(', ')}`,
          `project_ids: ${pids.slice(0, 6).join(', ')}${pids.length > 6 ? ` …+${pids.length - 6}` : ''}`,
        ],
        confidence: 'certain',
      });
    }
  }

  // Whether site_url agrees with this slot's expected web port. Again a fact —
  // no guessing about what the user will end up seeing.
  {
    const mismatches: string[] = [];
    for (const id of identities) {
      const slot = layout.slotFromProjectId(id.projectId);
      if (slot === null) continue;
      const web = layout.expect(slot).ports.web;
      if (web == null) continue;
      const m = /:(\d+)\s*$/.exec(id.siteUrl) ?? /localhost:(\d+)/.exec(id.siteUrl);
      const sitePort = m ? Number(m[1]) : null;
      if (sitePort === web) continue;
      mismatches.push(`  SLOT=${slot} site_url=${id.siteUrl} expected web=${web}`);
    }
    if (mismatches.length > 0) {
      out.push({
        severity: 'warning',
        kind: 'site-url-mismatch',
        message: `${mismatches.length} running environment${s(mismatches.length)} with a site_url that disagrees with the expected web port`,
        evidence: mismatches.slice(0, 10),
        confidence: 'certain',
      });
    }
  }

  // ── 6. Port squatters: non-docker processes on this layout's ports ──
  // Inside a known worktree      -> ignore, that is the dev server working.
  // Under a shared parent dir
  //   but not a live worktree    -> orphan, the directory was probably deleted.
  // Anywhere else                -> foreign.
  for (const l of listeners) {
    const hit = layout.slotFromPort(l.port);
    if (!hit) continue;
    if (l.command.startsWith('com.docke') || l.command.startsWith('docker')) continue;
    const pathHint = listenerPathHint(l);
    const home = listenerHome(pathHint, mainRoot, worktrees);
    if (home === 'worktree') continue;
    if (home === 'family') {
      out.push({
        severity: foreignPortSeverity(hit.role),
        kind: 'orphan-port',
        slot: hit.slot,
        message: `SLOT=${hit.slot} ${hit.role} port ${l.port} held by a leftover process from this project`,
        evidence: [
          `${l.command} (pid ${l.pid})`,
          pathHint ? `path ${pathHint}` : 'path unknown',
          ...(l.cwd ? [] : ['cwd unavailable, path inferred from command']),
          'under a worktree parent dir but not in the current git worktree list (dir may be deleted)',
        ],
        confidence: l.cwd || pathHint ? 'certain' : 'uncertain',
      });
      continue;
    }
    out.push({
      severity: foreignPortSeverity(hit.role),
      kind: 'foreign-port',
      slot: hit.slot,
      message: `SLOT=${hit.slot} ${hit.role} port ${l.port} held by an outside process`,
      evidence: foreignPortEvidence(hit.role, l),
      confidence: pathHint ? 'certain' : 'uncertain',
    });
  }

  // ── 7. Leftovers at the git level ───────────────────────────────────
  const prunable = worktrees.filter(w => w.prunable || !w.exists);
  if (prunable.length > 0) {
    out.push({
      severity: 'info',
      kind: 'prunable',
      message: `${prunable.length} worktree dir${s(prunable.length)} ${prunable.length === 1 ? 'is' : 'are'} gone but git metadata remains`,
      evidence: [...prunable.slice(0, 6).map(w => `  ${name(w.path)}`), '→ git worktree prune'],
      confidence: 'certain',
    });
  }

  const ephemeral = worktrees.filter(w => /^\/(private\/)?(tmp|var\/folders)\//.test(w.path));
  if (ephemeral.length > 0) {
    out.push({
      severity: 'info',
      kind: 'ephemeral',
      message: `${ephemeral.length} worktree${s(ephemeral.length)} live under a temp dir`,
      evidence: [...ephemeral.slice(0, 4).map(w => `  ${w.path}`), 'git loses track once the system cleans them up'],
      confidence: 'certain',
    });
  }

  const rank = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** Counts can be 1. A report that says "1 worktrees" makes the reader start
 *  doubting every other number in it. */
function s(n: number): string {
  return n === 1 ? '' : 's';
}

export function fmtMem(miB: number): string {
  return miB >= 1024 ? `${(miB / 1024).toFixed(2)}G` : `${Math.round(miB)}M`;
}
