// node --test src/analyze.test.ts
// Only analyze's decision logic is tested here: given observation X, report Y.
// The probe layer is covered by test/e2e.sh against real docker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, type Input } from './analyze.ts';
import { exampleLayout } from './layouts/example.ts';
import type { Worktree, Container, Listener } from './probe.ts';
import type { Declaration } from './declarations.ts';

const MAIN = '/repo';

function wt(path: string): Worktree {
  return { path, branch: null, head: '', prunable: false, exists: true, isMain: path === MAIN };
}
function decl(path: string, projectId: string): Declaration {
  return {
    worktree: wt(path),
    effective: { projectId, slot: exampleLayout.slotFromProjectId(projectId) },
    intent: null,
    intentBroken: false,
  };
}
function container(
  projectId: string,
  name = 'supabase_db_' + projectId,
  state: Container['state'] = 'running',
): Container {
  return { name, projectId, uptime: '2 hours ago', status: state === 'running' ? 'Up 2 hours' : 'Exited (0) 3 weeks ago', memMiB: 100, cpuPct: 0, state };
}
function input(over: Partial<Input>): Input {
  return {
    layout: exampleLayout, mainRoot: MAIN,
    worktrees: [], containers: [], listeners: [], declarations: [], identities: [],
    volumes: [],
    ...over,
  };
}
const kinds = (i: Input) => analyze(i).findings.map(f => f.kind);

test('two worktrees claiming one slot is a collision', () => {
  const ds = [decl('/a', 'example-app-s4'), decl('/b', 'example-app-s4')];
  const f = analyze(input({ declarations: ds, worktrees: ds.map(d => d.worktree) })).findings;
  assert.equal(f.filter(x => x.kind === 'collision').length, 1);
  assert.equal(f[0].slot, 4);
  assert.equal(f[0].confidence, 'certain');
});

test('an idle collision is a warning; it becomes critical once containers run', () => {
  const ds = [decl('/a', 'example-app-s4'), decl('/b', 'example-app-s4')];
  const base = { declarations: ds, worktrees: ds.map(d => d.worktree) };

  const idle = analyze(input(base)).findings.find(f => f.kind === 'collision')!;
  assert.equal(idle.severity, 'warning', 'nothing running yet, so it is still free to fix');

  const live = analyze(input({ ...base, containers: [container('example-app-s4')] }))
    .findings.find(f => f.kind === 'collision')!;
  assert.equal(live.severity, 'critical', 'already running means data may already have crossed');
});

test('the main repo alone on the default project_id is not a problem', () => {
  const ds = [decl(MAIN, 'example-app')];
  assert.ok(!kinds(input({ declarations: ds, worktrees: ds.map(d => d.worktree) })).includes('unassigned-default'));
});

test('several worktrees left on the default project_id are unallocated (main repo excluded)', () => {
  const ds = [
    decl(MAIN, 'example-app'),
    decl('/x', 'example-app'),
    decl('/y', 'example-app'),
  ];
  const f = analyze(input({ declarations: ds, worktrees: ds.map(d => d.worktree) })).findings
    .find(x => x.kind === 'unassigned-default')!;
  assert.ok(f, 'should report unallocated');
  assert.match(f.message, /^2 worktrees/, 'the main repo must not be counted');
});

test('noise control: ephemeral and stale worktrees do not push this to critical', () => {
  const live = decl('/workspaces/demo/real-a', 'example-app');
  const live2 = decl('/workspaces/demo/real-b', 'example-app');
  const tmp = decl('/private/tmp/staging-check', 'example-app');
  tmp.worktree = { ...tmp.worktree, exists: true };
  const gone = decl('/workspaces/demo/deleted', 'example-app');
  gone.worktree = { ...gone.worktree, exists: false, prunable: true };

  // one actionable plus noise -> not critical
  const onlyNoise = analyze(input({
    declarations: [decl(MAIN, 'example-app'), live, tmp, gone],
    worktrees: [wt(MAIN), live.worktree, tmp.worktree, gone.worktree],
  })).findings;
  assert.ok(!onlyNoise.some(f => f.kind === 'unassigned-default' && f.severity === 'critical'));
  assert.ok(onlyNoise.some(f => f.kind === 'unassigned-noise'));

  // two actionable plus noise -> critical, counting only the actionable ones
  const withLive = analyze(input({
    declarations: [decl(MAIN, 'example-app'), live, live2, tmp],
    worktrees: [wt(MAIN), live.worktree, live2.worktree, tmp.worktree],
  })).findings.find(f => f.kind === 'unassigned-default')!;
  assert.equal(withLive.severity, 'critical');
  assert.match(withLive.message, /^2 worktrees/);
  assert.ok(withLive.evidence.some(e => /excluded/.test(e)));
  assert.ok(!withLive.suggestion!.includes('/private/tmp'));
});

test('containers with no declaration are unclaimed', () => {
  const f = analyze(input({ containers: [container('example-app-s11')] })).findings
    .find(x => x.kind === 'unclaimed')!;
  assert.ok(f);
  assert.equal(f.slot, 11);
  assert.match(f.suggestion!, /another clone/);
  assert.ok(!/docker rm/.test(f.suggestion!), 'a running unclaimed stack must never offer docker rm');
});

test('a declaration with no environment behind it is a phantom', () => {
  const d: Declaration = {
    worktree: wt('/ghost'), effective: null, intentBroken: false,
    intent: { slot: 9, ports: {}, projectId: 'example-app-s9' },
  };
  assert.ok(kinds(input({ declarations: [d], worktrees: [d.worktree] })).includes('phantom'));
});

test('registry file disagreeing with config.toml is intent drift', () => {
  const d: Declaration = {
    worktree: wt('/drift'),
    effective: { projectId: 'example-app-s15', slot: 15 },
    intent: { slot: 14, ports: {} },
    intentBroken: false,
  };
  const f = analyze(input({ declarations: [d], worktrees: [d.worktree] })).findings
    .find(x => x.kind === 'intent-drift')!;
  assert.ok(f);
  assert.equal(f.slot, 15, 'ownership follows config.toml, which is what the CLI actually reads');
});

test('an identical JWT secret across environments warns; distinct secrets do not', () => {
  const same = [
    { projectId: 'p1', jwtFingerprint: 'aaaa', siteUrl: 'http://localhost:3000' },
    { projectId: 'p2', jwtFingerprint: 'aaaa', siteUrl: 'http://localhost:3000' },
  ];
  assert.ok(kinds(input({ identities: same })).includes('identity'));

  const diff = [
    { projectId: 'p1', jwtFingerprint: 'aaaa', siteUrl: 'x' },
    { projectId: 'p2', jwtFingerprint: 'bbbb', siteUrl: 'y' },
  ];
  assert.ok(!kinds(input({ identities: diff })).includes('identity'));
});

test('port lookup and port generation are inverses', () => {
  for (const slot of [0, 4, 15, 19]) {
    const { ports } = exampleLayout.expect(slot);
    assert.deepEqual(exampleLayout.slotFromPort(ports.api), { slot, role: 'api' });
    assert.deepEqual(exampleLayout.slotFromPort(ports.web), { slot, role: 'web' });
  }
  assert.equal(exampleLayout.slotFromPort(9999), null);
});

// ── Corrections from real usage ─────────────────────────────────

test('volumes but no containers is cold; neither is a phantom', () => {
  const coldDecl: Declaration = {
    worktree: wt('/cold-wt'), effective: null, intentBroken: false,
    intent: { slot: 5, ports: {}, projectId: 'example-app-s5' },
  };
  const ghostDecl: Declaration = {
    worktree: wt('/ghost-wt'), effective: null, intentBroken: false,
    intent: { slot: 8, ports: {}, projectId: 'example-app-s8' },
  };
  const volumes = [
    'supabase_db_example-app-s5',
    'supabase_storage_example-app-s5',
  ];
  const findings = analyze(input({
    declarations: [coldDecl, ghostDecl],
    worktrees: [coldDecl.worktree, ghostDecl.worktree],
    volumes,
  })).findings;

  const cold = findings.find(f => f.kind === 'cold');
  const phantom = findings.find(f => f.kind === 'phantom');
  assert.ok(cold, 'volumes present, so cold');
  assert.equal(cold!.severity, 'info');
  assert.match(cold!.message, /data kept/);
  assert.ok(cold!.evidence.some(e => e.includes('cold-wt')));
  assert.ok(!cold!.evidence.some(e => e.includes('ghost-wt')));

  assert.ok(phantom, 'no volumes, so phantom');
  assert.equal(phantom!.severity, 'info');
  assert.match(phantom!.message, /neither containers nor data/);
  assert.ok(phantom!.evidence.some(e => e.includes('ghost-wt')));
  assert.ok(!phantom!.evidence.some(e => e.includes('cold-wt')));

  // SlotView carries its volumes
  const { slots } = analyze(input({
    declarations: [coldDecl],
    worktrees: [coldDecl.worktree],
    volumes,
  }));
  // a cold slot has intent but no effective config, so use one with a claimant
  const withClaim = decl('/c', 'example-app-s5');
  const views = analyze(input({
    declarations: [withClaim],
    worktrees: [withClaim.worktree],
    volumes,
  })).slots;
  const s5 = views.find(s => s.slot === 5)!;
  assert.ok(s5);
  assert.deepEqual(s5.volumes.sort(), volumes.sort());
});

test('foreign-port severity follows the role: metro is info, db is warning', () => {
  const metro: Listener = { port: 8121, pid: 1, command: 'node', cwd: '/other/project' }; // slot 4 metro
  const db: Listener = { port: 54362, pid: 2, command: 'postgres', cwd: '/other/project' }; // slot 4 db

  const metroF = analyze(input({ listeners: [metro] })).findings.find(f => f.kind === 'foreign-port')!;
  assert.ok(metroF);
  assert.equal(metroF.severity, 'info', 'metro carries no data');
  assert.ok(metroF.evidence.some(e => /metro|ignore/.test(e)));

  const dbF = analyze(input({ listeners: [db] })).findings.find(f => f.kind === 'foreign-port')!;
  assert.ok(dbF);
  assert.equal(dbF.severity, 'warning', 'db means connecting to the wrong database');
  assert.ok(dbF.evidence.some(e => /wrong database/.test(e)));
});

test('unassigned-default is critical, while collision severity is unchanged', () => {
  const ds = [
    decl(MAIN, 'example-app'),
    decl('/x', 'example-app'),
    decl('/y', 'example-app'),
  ];
  const f = analyze(input({ declarations: ds, worktrees: ds.map(d => d.worktree) })).findings
    .find(x => x.kind === 'unassigned-default')!;
  assert.ok(f);
  assert.equal(f.severity, 'critical', 'systemic non-allocation has to be critical, or exit 2 never fires');

  // an idle collision stays a warning
  const collide = [decl('/a', 'example-app-s4'), decl('/b', 'example-app-s4')];
  const c = analyze(input({ declarations: collide, worktrees: collide.map(d => d.worktree) })).findings
    .find(x => x.kind === 'collision')!;
  assert.equal(c.severity, 'warning');
});

test('collision and unassigned-default suggestions are paste-ready commands', () => {
  // lexicographic order: /alpha is kept, /beta gets reassigned
  const collide = [
    decl('/beta', 'example-app-s4'),
    decl('/alpha', 'example-app-s4'),
  ];
  const c = analyze(input({ declarations: collide, worktrees: collide.map(d => d.worktree) })).findings
    .find(x => x.kind === 'collision')!;
  assert.ok(c.suggestion);
  assert.match(c.suggestion!, /keep alpha/);
  assert.match(c.suggestion!, /cd '\/beta' && rm -f \.wt-slot && slotyard alloc/);
  assert.match(c.suggestion!, /start the stack/);

  const un = [
    decl(MAIN, 'example-app'),
    decl('/wt-a', 'example-app'),
    decl('/wt-b', 'example-app'),
  ];
  const u = analyze(input({ declarations: un, worktrees: un.map(d => d.worktree) })).findings
    .find(x => x.kind === 'unassigned-default')!;
  assert.ok(u.suggestion);
  // unallocated worktrees usually have no registry file, so do not tell the
  // user to remove one
  assert.match(u.suggestion!, /cd '\/wt-a' && slotyard alloc/);
  assert.match(u.suggestion!, /cd '\/wt-b' && slotyard alloc/);
  assert.ok(!/rm \.wt-slot/.test(u.suggestion!));
});

test('suggestion cd quotes a worktree path that contains spaces', () => {
  const collide = [
    decl('/alpha', 'example-app-s4'),
    decl('/wt/my feature', 'example-app-s4'),
  ];
  const c = analyze(input({ declarations: collide, worktrees: collide.map(d => d.worktree) })).findings
    .find(x => x.kind === 'collision')!;
  assert.match(c.suggestion!, /cd '\/wt\/my feature'/);
  assert.ok(!/cd \/wt\/my feature/.test(c.suggestion!), 'an unquoted cd would break on the space');
});

test('default suggestions mention slotyard alloc and configPath, not a lifecycle script', () => {
  const collide = [
    decl('/beta', 'example-app-s4'),
    decl('/alpha', 'example-app-s4'),
  ];
  const c = analyze(input({ declarations: collide, worktrees: collide.map(d => d.worktree) })).findings
    .find(x => x.kind === 'collision')!;
  assert.match(c.suggestion!, /slotyard alloc/);
  assert.match(c.suggestion!, /apps\/web\/supabase\/config\.toml/);
  assert.match(c.suggestion!, /supabase CLI reads that file/);
  assert.ok(!/wt-supabase-lifecycle\.sh/.test(c.suggestion!));
  assert.ok(!/tools\/lifecycle/.test(c.suggestion!));

  const un = [
    decl(MAIN, 'example-app'),
    decl('/wt-a', 'example-app'),
    decl('/wt-b', 'example-app'),
  ];
  const u = analyze(input({ declarations: un, worktrees: un.map(d => d.worktree) })).findings
    .find(x => x.kind === 'unassigned-default')!;
  assert.match(u.suggestion!, /slotyard alloc/);
  assert.match(u.suggestion!, /apps\/web\/supabase\/config\.toml/);
  assert.ok(!/wt-supabase-lifecycle\.sh/.test(u.suggestion!));
  assert.ok(!/tools\/lifecycle/.test(u.suggestion!));
});

test('layout.fixUp is used in suggestions when present', () => {
  const layout = { ...exampleLayout, fixUp: './tools/up.sh' };
  const collide = [
    decl('/beta', 'example-app-s4'),
    decl('/alpha', 'example-app-s4'),
  ];
  const c = analyze(input({
    layout, declarations: collide, worktrees: collide.map(d => d.worktree),
  })).findings.find(x => x.kind === 'collision')!;
  assert.match(c.suggestion!, /cd '\/beta' && rm -f \.wt-slot && \.\/tools\/up\.sh/);
  assert.ok(!c.suggestion!.includes('/beta && ./tools/up.sh'), 'fixUp must not have the path interpolated into it');

  const un = [
    decl(MAIN, 'example-app'),
    decl('/wt-a', 'example-app'),
    decl('/wt-b', 'example-app'),
  ];
  const u = analyze(input({
    layout, declarations: un, worktrees: un.map(d => d.worktree),
  })).findings.find(x => x.kind === 'unassigned-default')!;
  assert.match(u.suggestion!, /cd '\/wt-a' && \.\/tools\/up\.sh/);
  assert.match(u.suggestion!, /cd '\/wt-b' && \.\/tools\/up\.sh/);
  assert.ok(!/rm -f \.wt-slot/.test(u.suggestion!), 'unassigned still does not rm the registry');
  assert.ok(!/slotyard alloc/.test(u.suggestion!), 'fixUp replaces the generic alloc steps');
});

test('volumeBelongsTo: the default project_id does not swallow its -sN siblings', () => {
  assert.equal(
    exampleLayout.stack.volumeBelongsTo('supabase_db_example-app-s2', 'example-app'),
    false,
  );
  assert.equal(
    exampleLayout.stack.volumeBelongsTo('supabase_db_example-app-s2', 'example-app-s2'),
    true,
  );
});

test('volumeBelongsTo: prefix id "app" does not match volume "..._myapp"', () => {
  assert.equal(
    exampleLayout.stack.volumeBelongsTo('supabase_db_myapp', 'app'),
    false,
  );
  assert.equal(
    exampleLayout.stack.volumeBelongsTo('supabase_db_myapp', 'myapp'),
    true,
  );
});

// ── Cases found by using the tool on a real machine ─────────────

test('the unallocated suggestion lists only actionable worktrees, never temp dirs', () => {
  const un = [
    decl(MAIN, 'example-app'),
    decl('/private/tmp/staging-check', 'example-app'),
    decl('/workspaces/demo/real-a', 'example-app'),
    decl('/workspaces/demo/real-b', 'example-app'),
  ];
  const u = analyze(input({ declarations: un, worktrees: un.map(d => d.worktree) })).findings
    .find(x => x.kind === 'unassigned-default')!;
  assert.ok(u);
  assert.match(u.message, /^2 worktrees/);
  assert.ok(u.suggestion!.includes('/workspaces/demo/real-a'));
  assert.ok(u.suggestion!.includes('/workspaces/demo/real-b'));
  assert.ok(!u.suggestion!.includes('/private/tmp'), 'a temp directory must not appear in a fix command');
});

test('a live sibling under a shared parent is foreign-port, not orphan-port', () => {
  const wts = [wt('/hub/a'), wt('/hub/b')];
  const sibling: Listener = { port: 8221, pid: 2, command: 'node', cwd: '/hub/other-project' };
  const f = analyze(input({
    mainRoot: '/hub/main',
    worktrees: wts,
    listeners: [sibling],
    pathExists: () => true,
  })).findings;
  assert.ok(f.some(x => x.kind === 'foreign-port'), 'a live tree under the shared parent is another project');
  assert.ok(!f.some(x => x.kind === 'orphan-port'), 'orphan-port is for deleted leftovers, not a path that still exists');
});

test('a listener alone conjures no slot row; a shared-parent cwd is orphan-port', () => {
  const wts = [wt('/hub/a'), wt('/hub/b')];
  const foreign: Listener = { port: 8121, pid: 1, command: 'node', cwd: '/other/app' };
  const orphan: Listener = { port: 8221, pid: 2, command: 'node', cwd: '/hub/deleted-wt/apps/mobile' };

  const onlyForeign = analyze(input({ listeners: [foreign] }));
  assert.equal(onlyForeign.slots.length, 0, 'a purely foreign port must not produce a slot row');
  assert.ok(onlyForeign.findings.some(f => f.kind === 'foreign-port'));

  const withFamily = analyze(input({
    mainRoot: '/hub/main',
    worktrees: wts,
    listeners: [orphan],
  }));
  assert.ok(withFamily.findings.some(f => f.kind === 'orphan-port'), 'a leftover under the same parent is orphan-port');
  assert.ok(!withFamily.findings.some(f => f.kind === 'foreign-port' && f.slot === 14));
});

test('a half-asleep stack is partial-stack; fully stopped is not running', () => {
  const pid = 'example-app-s17';
  const live = container(pid, `supabase_db_${pid}`, 'running');
  const sleep = container(pid, `supabase_realtime_${pid}`, 'exited');
  const { slots, findings } = analyze(input({ containers: [live, sleep] }));
  const s = slots.find(x => x.slot === 17)!;
  assert.equal(s.running, true);
  assert.deepEqual(s.sleeping, ['realtime']);
  const f = findings.find(x => x.kind === 'partial-stack')!;
  assert.ok(f);
  assert.equal(f.severity, 'info', 'realtime is sleepable, so info');
  assert.match(f.suggestion!, /slotyard wake 17/);

  const coreDown = container(pid, `supabase_auth_${pid}`, 'exited');
  const warn = analyze(input({ containers: [live, coreDown] })).findings
    .find(x => x.kind === 'partial-stack')!;
  assert.equal(warn.severity, 'warning', 'auth is not sleepable, so warning');

  const allDead = analyze(input({
    containers: [container(pid, `supabase_db_${pid}`, 'exited')],
  }));
  // dead containers with no declaration and no volume: no slot row, no finding
  assert.equal(allDead.slots.length, 0);
  assert.ok(!allDead.findings.some(x => x.kind === 'partial-stack'));
});

test('a site_url disagreeing with the expected web port is reported as fact only', () => {
  const ids = [
    { projectId: 'example-app-s3', jwtFingerprint: 'aaaa', siteUrl: 'http://localhost:3000' },
    { projectId: 'example-app-s15', jwtFingerprint: 'bbbb', siteUrl: 'http://localhost:3250' },
  ];
  const findings = analyze(input({ identities: ids })).findings;
  const mismatch = findings.filter(f => f.kind === 'site-url-mismatch');
  assert.equal(mismatch.length, 1);
  assert.match(mismatch[0].message, /^1 running environment /);
  assert.ok(mismatch[0].evidence.some(e => /SLOT=3/.test(e) && /3000/.test(e) && /3130/.test(e)));
  // matching ones stay out of the evidence
  assert.ok(!mismatch[0].evidence.some(e => /SLOT=15/.test(e)));
});

test('orphan-port is still recognised from the command line when cwd is missing', () => {
  const wts = [wt('/hub/a'), wt('/hub/b')];
  const orphan: Listener = {
    port: 8221, pid: 9, cwd: null,
    command: 'node /hub/deleted-wt/node_modules/.bin/expo start --port 8221',
  };
  const f = analyze(input({ mainRoot: '/hub/main', worktrees: wts, listeners: [orphan] }))
    .findings.find(x => x.kind === 'orphan-port');
  assert.ok(f);
  assert.match(f!.evidence.join('\n'), /deleted-wt/);
});

// A stack left behind by a deleted worktree is almost always stopped — that is
// the normal state of an abandoned environment, and the one orphan docker can
// never work out for itself (it only reference-counts, and cannot see git).
// While unclaimed only examined running slots, this class was invisible.
test('orphan: the worktree is gone but the data remains, and it is stopped', () => {
  const orphan = analyze(input({
    worktrees: [wt(MAIN)],
    declarations: [decl(MAIN, 'example-app')],
    containers: [container('example-app-s7', undefined, 'exited')],
    volumes: ['supabase_db_example-app-s7'],
  }));
  const f = orphan.findings.find(x => x.kind === 'orphan-data');
  assert.ok(f, 'a stopped unclaimed slot with volumes must be reported');
  assert.equal(f!.slot, 7);
  assert.equal(f!.severity, 'warning', 'it is data, not garbage — but not worth interrupting someone over either');
  assert.match(f!.message, /no worktree claims it/);
  assert.ok(f!.suggestion, 'must come with a paste-ready command');
});

// A declared cold environment is one the user is deliberately keeping. Reporting
// it as an orphan is the only direction this check can be wrong in, and being
// wrong once means somebody deletes their own database.
test('orphan: a foreign workDir is another clone, never a paste-ready docker rm', () => {
  const orphan = analyze(input({
    worktrees: [wt(MAIN)],
    declarations: [decl(MAIN, 'example-app')],
    containers: [{ ...container('example-app-s7', undefined, 'exited'), workDir: '/other/clone' }],
    volumes: ['supabase_db_example-app-s7'],
  }));
  const f = orphan.findings.find(x => x.kind === 'orphan-data');
  assert.ok(f);
  assert.match(f!.evidence.join('\n'), /\/other\/clone/);
  assert.match(f!.evidence.join('\n'), /another clone/);
  assert.ok(!/docker rm/.test(f!.suggestion!));
  assert.ok(!/volume rm/.test(f!.suggestion!));
});

test('orphan: unknown workDir still warns, inspect comes before any rm', () => {
  const orphan = analyze(input({
    worktrees: [wt(MAIN)],
    declarations: [decl(MAIN, 'example-app')],
    containers: [container('example-app-s7', undefined, 'exited')],
    volumes: ['supabase_db_example-app-s7'],
  }));
  const f = orphan.findings.find(x => x.kind === 'orphan-data');
  assert.ok(f);
  assert.equal(f!.severity, 'warning');
  assert.match(f!.suggestion!, /another clone/);
  const inspectAt = f!.suggestion!.search(/docker (volume )?inspect/);
  const rmAt = f!.suggestion!.search(/docker rm|volume rm/);
  assert.ok(inspectAt >= 0, 'must inspect first');
  assert.ok(rmAt >= 0, 'unknown may still offer deletion, but last');
  assert.ok(inspectAt < rmAt, 'never lead with docker rm');
});

test('orphan: a cold environment with a claimant is not an orphan', () => {
  const cold = analyze(input({
    worktrees: [wt(MAIN), wt('/wt/alpha')],
    declarations: [
      decl(MAIN, 'example-app'),
      decl('/wt/alpha', 'example-app-s7'),
    ],
    containers: [container('example-app-s7', undefined, 'exited')],
    volumes: ['supabase_db_example-app-s7'],
  }));
  assert.ok(!cold.findings.some(f => f.kind === 'orphan-data'), 'claimed, therefore not an orphan');
});

// No volumes means nothing to lose. That is a phantom (info), not a warning.
test('orphan: unclaimed but with no data is not orphan-data', () => {
  const empty = analyze(input({
    worktrees: [wt(MAIN)],
    declarations: [decl(MAIN, 'example-app')],
    containers: [container('example-app-s7', undefined, 'exited')],
    volumes: [],
  }));
  assert.ok(!empty.findings.some(f => f.kind === 'orphan-data'));
});
