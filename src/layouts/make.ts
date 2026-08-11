// Layout factory. Turns "port formula, project_id naming" from hard-coded
// TypeScript into a spec a project can declare.
//
// A spec declares CONVENTIONS (what the port formula is), never STATE (who
// currently holds slot 7). That line matters: a convention is a decision, and
// decisions belong in files. State is an observable fact and must be probed.
// Adding an `assignments` field here would cross it — and turn this tool into
// exactly the thing it exists to eliminate.

import { type Layout, SUPABASE_STACK } from './types.ts';

export type LayoutSpec = {
  name: string;
  /** project_id prefix. The main worktree uses it bare; every other slot is
   *  `${prefix}-s${slot}`. */
  prefix: string;
  /** Where config.toml sits, relative to the repo root */
  configPath: string;
  /** role -> the port it uses at slot 0 */
  ports: Record<string, number>;
  /** Gap between adjacent slots. supabase occupies 6 consecutive ports, which
   *  makes 10 the only sensible default. */
  step?: number;
  maxSlot?: number;
  registryFile?: string;
};

const DEFAULT_STEP = 10;
const DEFAULT_MAX_SLOT = 19;

/** The prefix gets spliced into a regex. Without escaping, a project named
 *  `a.b+c` would match names it does not own. */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function makeLayout(spec: LayoutSpec): Layout {
  const step = spec.step ?? DEFAULT_STEP;
  const maxSlot = spec.maxSlot ?? DEFAULT_MAX_SLOT;
  const inRange = (n: number) => Number.isInteger(n) && n >= 0 && n <= maxSlot;
  const slotRe = new RegExp(`^${escapeRe(spec.prefix)}-s(\\d+)$`);

  return {
    name: spec.name,
    stack: SUPABASE_STACK,
    configPath: spec.configPath,
    maxSlot,

    slotFromProjectId(projectId) {
      if (projectId === spec.prefix) return 0; // main worktree uses the bare id
      const m = slotRe.exec(projectId);
      if (!m) return null;
      const slot = Number(m[1]);
      return inRange(slot) ? slot : null;
    },

    slotFromPort(port) {
      for (const [role, base] of Object.entries(spec.ports)) {
        const delta = port - base;
        if (delta % step !== 0) continue;
        const slot = delta / step;
        if (inRange(slot)) return { slot, role };
      }
      return null;
    },

    expect(slot) {
      const ports: Record<string, number> = {};
      for (const [role, base] of Object.entries(spec.ports)) ports[role] = base + slot * step;
      return { projectId: slot === 0 ? spec.prefix : `${spec.prefix}-s${slot}`, ports };
    },

    registry: {
      file: spec.registryFile ?? '.wt-slot',
      parse(content) {
        const kv: Record<string, string> = {};
        for (const line of content.split('\n')) {
          const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
          if (m) kv[m[1]] = m[2];
        }
        if (!kv.SLOT) return null; // empty file, or no SLOT line -> not a declaration
        const slot = Number(kv.SLOT);
        if (!Number.isInteger(slot)) return null;
        const ports: Record<string, number> = {};
        for (const role of Object.keys(spec.ports)) {
          const v = kv[role.toUpperCase()];
          if (v) ports[role] = Number(v);
        }
        return { slot, ports, projectId: kv.PROJECT_ID };
      },
    },
  };
}

/**
 * Explicit config wins over inference. `ports` merges rather than replaces:
 * users normally just want to add web/metro, not restate everything supabase
 * already told us.
 */
export function mergeSpec(base: LayoutSpec, over: Partial<LayoutSpec>): LayoutSpec {
  return {
    ...base,
    ...Object.fromEntries(Object.entries(over).filter(([, v]) => v !== undefined)),
    ports: { ...base.ports, ...(over.ports ?? {}) },
  };
}

/**
 * Read project_id and each section's base port out of supabase's config.toml.
 *
 * Hand-parsed rather than pulling in a TOML library: we need exactly these few
 * fields, and a dependency would break the zero-dependency constraint.
 */
export function parseSupabaseConfig(
  content: string,
): { projectId: string; ports: Record<string, number> } | null {
  const pid = /^\s*project_id\s*=\s*"([^"]+)"/m.exec(content);
  if (!pid) return null;

  const ports: Record<string, number> = {};
  let section = '';
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    const sec = /^\[([^\]]+)\]/.exec(line);
    if (sec) { section = sec[1]; continue; }
    // Section names must match exactly: the port under [db.pooler] must not
    // overwrite the one under [db].
    const num = (re: RegExp) => {
      const m = re.exec(line);
      return m ? Number(m[1]) : null;
    };
    const p = num(/^port\s*=\s*(\d+)/);
    if (p !== null && ['api', 'db', 'studio', 'inbucket'].includes(section)) {
      ports[section] ??= p;
    }
    if (section === 'inbucket') {
      const smtp = num(/^smtp_port\s*=\s*(\d+)/);
      if (smtp !== null) ports.smtp ??= smtp;
      const pop3 = num(/^pop3_port\s*=\s*(\d+)/);
      if (pop3 !== null) ports.pop3 ??= pop3;
    }
  }
  if (Object.keys(ports).length === 0) return null;
  return { projectId: pid[1], ports };
}
