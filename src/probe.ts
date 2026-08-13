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
  /** Host path docker exposes for this container, if any — compose
   *  `working_dir` or a bind-mount Source. Another clone of the same
   *  project_id is how silent database sharing happens across repos; this is
   *  the only probe that can tell that clone from a worktree in *this* repo.
   *  Absent when docker does not stamp a path (common for named volumes). */
  workDir?: string | null;
};

/** docker Names are tab-free; inspect .Name is prefixed with `/`. */
function bareName(name: string): string {
  return name.replace(/^\//, '');
}

/** Compose stamps the project directory on every service. Empty / `<no value>`
 *  means docker did not stamp one — leave null rather than inventing a path. */
function composeWorkDir(workingDir?: string, projectDir?: string): string | null {
  for (const raw of [workingDir, projectDir]) {
    if (!raw || raw === '<no value>') continue;
    const t = raw.trim();
    if (t) return t;
  }
  return null;
}

function firstBindSource(mounts: { Type?: string; Source?: string }[] | null): string | null {
  for (const m of mounts ?? []) {
    if (m.Type === 'bind' && m.Source?.startsWith('/')) return m.Source;
  }
  return null;
}

/** docker ps -a, plus an optional docker stats. stats is slow on a machine with
 *  many containers, so UI polling should skip it. Prefer { stats: false } and
 *  attachStats(mine) after filtering — docker is machine-wide and stats on the
 *  unfiltered list is the slow step we used to pay for foreign projects. */
export async function probeContainers(
  labelKey: string,
  opts: { stats?: boolean } = {},
): Promise<Container[]> {
  const wantStats = opts.stats !== false;
  // Extra compose-dir columns after the original five. Names contain no tabs,
  // so splitting on \t does not break the existing parse if a column is empty.
  const psOut = await run('docker', [
    'ps', '-a', '--no-trunc',
    '--format',
    `{{.Names}}\t{{.Label "${labelKey}"}}\t{{.RunningFor}}\t{{.State}}\t{{.Status}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.Label "com.docker.compose.project.dir"}}`,
  ]);

  const containers: Container[] = [];
  for (const line of psOut.split('\n')) {
    if (!line.trim()) continue;
    const [name, label, uptime, stateRaw, status, workingDir, projectDir] = line.split('\t');
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
      workDir: composeWorkDir(workingDir, projectDir),
    });
  }
  if (wantStats) await attachStats(containers);
  return containers;
}

/** docker stats --no-stream on the running members of this list only. Mutates
 *  in place. Doctor must call this on the layout-filtered set, never on the
 *  machine-wide probeContainers result — stats is the slow step. */
export async function attachStats(containers: Container[]): Promise<void> {
  const running = containers.filter(c => c.state === 'running');
  if (running.length === 0) return;
  try {
    const statsOut = await run('docker', [
      'stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}',
      ...running.map(c => c.name),
    ]);
    const byName = new Map<string, Container>();
    for (const c of containers) byName.set(bareName(c.name), c);
    for (const line of statsOut.split('\n')) {
      if (!line.trim()) continue;
      const [name, mem, cpu] = line.split('\t');
      const c = byName.get(bareName(name ?? ''));
      if (!c) continue;
      c.memMiB = parseMem(mem);
      c.cpuPct = parseFloat(cpu) || 0;
    }
  } catch {
    // A stats failure must not take the whole doctor down. An empty memory
    // column is a fine degradation.
  }
}

/** Fill workDir for containers the cheap ps labels missed. Inspects only the
 *  given list (doctor passes `mine`). Needed even on --fast: another clone of
 *  the same project_id is how silent database sharing happens, and that path
 *  is how analyze tells that clone from a worktree in this repo. */
export async function attachWorkDirs(containers: Container[]): Promise<void> {
  const need = containers.filter(c => !c.workDir);
  if (need.length === 0) return;
  try {
    const raw = await run('docker', [
      'inspect',
      ...need.map(c => c.name),
      '--format', '{{.Name}}\t{{json .Config.Labels}}\t{{json .Mounts}}',
    ]);
    const byName = new Map<string, Container>();
    for (const c of need) byName.set(bareName(c.name), c);
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const name = bareName(line.slice(0, tab));
      const rest = line.slice(tab + 1);
      const tab2 = rest.indexOf('\t');
      if (tab2 < 0) continue;
      const c = byName.get(name);
      if (!c || c.workDir) continue;
      let labels: Record<string, string> | null = null;
      let mounts: { Type?: string; Source?: string }[] | null = null;
      try {
        labels = JSON.parse(rest.slice(0, tab2));
        mounts = JSON.parse(rest.slice(tab2 + 1));
      } catch {
        continue;
      }
      c.workDir = composeWorkDir(
        labels?.['com.docker.compose.project.working_dir'],
        labels?.['com.docker.compose.project.dir'],
      ) ?? firstBindSource(mounts);
    }
  } catch {
    // Inspect failure must not take doctor down; workDir stays null and
    // analyze degrades to not knowing the clone.
  }
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
  // projectId comes from the already-probed Container, not from a hardcoded
  // label key — docker is machine-wide and the label is a stack convention.
  const byName = new Map(targets.map(t => [bareName(t.name), t]));
  try {
    // Name + JSON Config: env values can contain spaces and even newlines,
    // so JSON is the only safe delimiter for the env blob. inspect .Name is
    // prefixed with `/`; strip it to join on the docker-ps name.
    const raw = await run('docker', [
      'inspect', ...targets.map(t => t.name), '--format', '{{.Name}}\t{{json .Config}}',
    ]);
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const target = byName.get(bareName(line.slice(0, tab)));
      const projectId = target?.projectId;
      if (!projectId) continue;
      let cfg: { Env?: string[] };
      try {
        cfg = JSON.parse(line.slice(tab + 1)) as { Env?: string[] };
      } catch {
        continue;
      }
      const env = new Map((cfg.Env ?? []).map(l => {
        const i = l.indexOf('=');
        return [l.slice(0, i), l.slice(i + 1)] as [string, string];
      }));
      const secret = env.get('GOTRUE_JWT_SECRET');
      if (!secret) continue;
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
