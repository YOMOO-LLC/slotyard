// The probe layer — the only source of truth.
//
// Hard rule: every function here observes actual system state. None of them may
// read a declaration file to answer "what is running". Declaration files
// (.wt-slot / config.toml) are read separately by declarations.ts and exist only
// as a third view to compare against.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function run(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec(cmd, args, { maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (e: any) {
    if (e.code === 'ENOENT') throw new Error(`command not found: ${cmd}`);
    // `docker ps` exits non-zero when the daemon is down. Carry stderr up so the
    // caller can decide how loudly to report it.
    throw new Error(`${cmd} ${args[0]} failed: ${(e.stderr || e.message || '').trim().split('\n')[0]}`);
  }
}

export type ContainerState = 'running' | 'exited' | 'other';

export type Container = {
  name: string;
  projectId: string | null;
  uptime: string;
  /** Raw Status from docker ps. For a stopped container it reads like
   *  "Exited (0) 2 days ago" — which is what tells you whether a stack is
   *  abandoned. RunningFor measures "since created", so a stack stopped three
   *  months ago looks as fresh as one built yesterday. */
  status: string;
  memMiB: number | null;
  cpuPct: number | null;
  /** State from docker ps -a. sleep / partial-stack detection reads this, not
   *  just whether the status line starts with Up. */
  state: ContainerState;
};

/** docker ps -a, plus an optional docker stats. stats is slow on a machine with
 *  many containers, so UI polling should skip it. */
export async function probeContainers(
  labelKey: string,
  opts: { stats?: boolean } = {},
): Promise<Container[]> {
  const wantStats = opts.stats !== false;
  const psOut = await run('docker', [
    'ps', '-a', '--no-trunc',
    '--format', `{{.Names}}\t{{.Label "${labelKey}"}}\t{{.RunningFor}}\t{{.State}}\t{{.Status}}`,
  ]);

  const containers: Container[] = [];
  for (const line of psOut.split('\n')) {
    if (!line.trim()) continue;
    const [name, label, uptime, stateRaw, status] = line.split('\t');
    const state: ContainerState =
      stateRaw === 'running' ? 'running' : stateRaw === 'exited' ? 'exited' : 'other';
    containers.push({
      name,
      projectId: label || null,
      uptime: uptime ?? '',
      status: status ?? '',
      memMiB: null,
      cpuPct: null,
      state,
    });
  }
  if (containers.length === 0 || !wantStats) return containers;

  // stats only means anything for running containers, and it is the one slow
  // step here — seconds to tens of seconds once there are a lot of containers.
  const running = containers.filter(c => c.state === 'running');
  if (running.length === 0) return containers;
  try {
    const statsOut = await run('docker', [
      'stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}',
      ...running.map(c => c.name),
    ]);
    const byName = new Map(containers.map(c => [c.name, c]));
    for (const line of statsOut.split('\n')) {
      if (!line.trim()) continue;
      const [name, mem, cpu] = line.split('\t');
      const c = byName.get(name);
      if (!c) continue;
      c.memMiB = parseMem(mem);
      c.cpuPct = parseFloat(cpu) || 0;
    }
  } catch {
    // A stats failure must not take the whole doctor down. An empty memory
    // column is a fine degradation.
  }
  return containers;
}

function parseMem(usage: string): number | null {
  const m = /^([\d.]+)\s*([KMG])i?B/.exec(usage.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2] === 'G' ? n * 1024 : m[2] === 'K' ? n / 1024 : n;
}

export type Worktree = {
  path: string;
  branch: string | null;
  head: string;
  prunable: boolean;
  exists: boolean;
  isMain: boolean;
};

export async function probeWorktrees(cwd: string): Promise<{ mainRoot: string; worktrees: Worktree[] }> {
  const out = await run('git', ['-C', cwd, 'worktree', 'list', '--porcelain']);
  const worktrees: Worktree[] = [];
  let cur: Partial<Worktree> | null = null;

  const flush = () => { if (cur?.path) worktrees.push(cur as Worktree); };

  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      cur = { path: line.slice(9), branch: null, head: '', prunable: false, exists: false, isMain: false };
    } else if (line.startsWith('HEAD ') && cur) cur.head = line.slice(5);
    else if (line.startsWith('branch ') && cur) cur.branch = line.slice(7).replace('refs/heads/', '');
    else if (line.startsWith('prunable') && cur) cur.prunable = true;
  }
  flush();

  const { existsSync } = await import('node:fs');
  for (const w of worktrees) w.exists = existsSync(w.path);
  // git worktree list always puts the main repo first
  if (worktrees[0]) worktrees[0].isMain = true;

  return { mainRoot: worktrees[0]?.path ?? cwd, worktrees };
}

/**
 * Identity boundary probe: read the auth container's JWT secret and site_url.
 *
 * The secret is never stored, only fingerprinted. doctor is a read-only tool and
 * has no business printing somebody's key into a log or into --json output.
 */
export async function probeIdentities(
  containers: Container[],
  isAuthContainer: (name: string) => boolean,
): Promise<{ projectId: string; jwtFingerprint: string; siteUrl: string }[]> {
  // Only running auth containers. A stopped one still carries its env, but
  // counting it would fold cold stacks into "running identity collision".
  const targets = containers.filter(
    c => c.projectId && c.state === 'running' && isAuthContainer(c.name),
  );
  if (targets.length === 0) return [];

  const { createHash } = await import('node:crypto');
  const out: { projectId: string; jwtFingerprint: string; siteUrl: string }[] = [];
  try {
    // One JSON object per line: env values can contain spaces and even newlines,
    // so JSON is the only safe delimiter here.
    const raw = await run('docker', [
      'inspect', ...targets.map(t => t.name), '--format', '{{json .Config}}',
    ]);
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const cfg = JSON.parse(line) as { Labels?: Record<string, string>; Env?: string[] };
      const projectId = cfg.Labels?.['com.supabase.cli.project'];
      const env = new Map((cfg.Env ?? []).map(l => {
        const i = l.indexOf('=');
        return [l.slice(0, i), l.slice(i + 1)] as [string, string];
      }));
      const secret = env.get('GOTRUE_JWT_SECRET');
      if (!projectId || !secret) continue;
      out.push({
        projectId,
        jwtFingerprint: createHash('sha256').update(secret).digest('hex').slice(0, 16),
        siteUrl: env.get('GOTRUE_SITE_URL') ?? '(unset)',
      });
    }
  } catch { /* skip the identity check; the rest of the report still stands */ }
  return out;
}

/** Volume list. Returns [] on failure rather than taking the whole doctor down. */
export async function probeVolumes(): Promise<string[]> {
  try {
    const out = await run('docker', ['volume', 'ls', '--format', '{{.Name}}']);
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export type Listener = { port: number; pid: number; command: string; cwd: string | null };

/** Every listening port on the machine, including ports that belong to other
 *  projects — that is how cross-project port collisions get caught. */
export async function probeListeners(): Promise<Listener[]> {
  let out: string;
  try {
    out = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']);
  } catch {
    return []; // degrade when lsof is unavailable rather than failing outright
  }

  const listeners: Listener[] = [];
  let pid = 0, command = '';
  for (const line of out.split('\n')) {
    const tag = line[0], val = line.slice(1);
    if (tag === 'p') { pid = Number(val); command = ''; }
    else if (tag === 'c') command = val;
    else if (tag === 'n') {
      const m = /:(\d+)$/.exec(val);
      if (m) listeners.push({ port: Number(m[1]), pid, command, cwd: null });
    }
  }

  // Attribute processes by cwd, never by PPID. Measured: a PPID can become 1
  // within two seconds of a process starting, so using it to decide "orphan"
  // condemns healthy processes. cwd points straight at the worktree.
  const pids = [...new Set(listeners.map(l => l.pid))];
  const cwds = await resolveCwds(pids);
  for (const l of listeners) l.cwd = cwds.get(l.pid) ?? null;

  return listeners;
}

async function resolveCwds(pids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (pids.length === 0) return map;
  try {
    const out = await run('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn']);
    let pid = 0;
    for (const line of out.split('\n')) {
      if (line[0] === 'p') pid = Number(line.slice(1));
      else if (line[0] === 'n' && pid) map.set(pid, line.slice(1));
    }
  } catch { /* without cwd the attribution simply degrades to uncertain */ }
  return map;
}


/**
 * Every host port that any container on this machine DECLARES it will bind,
 * stopped containers included.
 *
 * Why lsof alone is not enough: a cold stack holds no ports at all right now, so
 * lsof cannot see it — but the moment it starts it will grab them. Measured: six
 * cold slots on one machine were in exactly that state. A second project's
 * allocator would hand those numbers out as free, and they would collide as soon
 * as the other side woke up.
 *
 * Deliberately NOT filtered by layout. Ports are a machine-wide resource and
 * other projects' containers hold them too. This is the only way two projects
 * coexist without the user having to configure anything.
 */
export async function probeReservedPorts(): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  let ids: string;
  try {
    ids = await run('docker', ['ps', '-aq']);
  } catch {
    return out; // degrade when docker is unavailable
  }
  const list = ids.split('\n').filter(Boolean);
  if (list.length === 0) return out;
  let raw: string;
  try {
    raw = await run('docker', [
      'inspect', '--format', '{{.Name}}\t{{json .HostConfig.PortBindings}}', ...list,
    ]);
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const name = line.slice(0, tab).replace(/^\//, '');
    let bindings: Record<string, { HostPort?: string }[]> | null;
    try {
      bindings = JSON.parse(line.slice(tab + 1));
    } catch {
      continue;
    }
    for (const arr of Object.values(bindings ?? {})) {
      for (const b of arr ?? []) {
        const port = Number(b?.HostPort);
        if (Number.isInteger(port) && port > 0 && !out.has(port)) out.set(port, name);
      }
    }
  }
  return out;
}
