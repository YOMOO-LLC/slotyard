// node --test src/allocate.test.ts
// Allocation is a pure decision: given observations, which slot is usable.
// The side effect — writing config.toml — deliberately lives elsewhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseSlot, occupiedSlots, ownerRoot, portBlockedSlots } from './allocate.ts';
import { exampleLayout } from './layouts/example.ts';
import type { Container } from './probe.ts';
import type { Declaration } from './declarations.ts';

const MAIN = '/repo';
const wt = (path: string) => ({
  path, branch: null, head: '', prunable: false, exists: true, isMain: path === MAIN,
});
const decl = (path: string, projectId: string): Declaration => ({
  worktree: wt(path),
  effective: { projectId, slot: exampleLayout.slotFromProjectId(projectId) },
  intent: null,
  intentBroken: false,
});
const cont = (projectId: string, state: Container['state'] = 'running'): Container => ({
  name: 'supabase_db_' + projectId,
  projectId,
  uptime: '2 hours ago',
  status: state === 'running' ? 'Up 2 hours' : 'Exited (0) 2 days ago',
  memMiB: null, cpuPct: null, state,
});
const blocked = (...pairs: [number, string][]) => new Map(pairs);
const base = {
  layout: exampleLayout, mainRoot: MAIN,
  containers: [], declarations: [], blockedPorts: new Map<number, string>(), cwd: '/wt/new',
};

test('occupancy comes from probing: containers count even with no declaration', () => {
  const occ = occupiedSlots({
    ...base,
    containers: [cont('example-app-s7')],
  });
  assert.ok(occ.has(7), 'a running container means taken, regardless of any declaration file');
});

test('occupancy also comes from config.toml, which is what the CLI actually reads', () => {
  const occ = occupiedSlots({
    ...base,
    declarations: [decl('/wt/alpha', 'example-app-s3')],
  });
  assert.ok(occ.has(3));
});

test('a stopped slot still counts as taken: its volumes are attached, so handing it out shares a database', () => {
  const occ = occupiedSlots({
    ...base,
    containers: [cont('example-app-s5', 'exited')],
  });
  assert.ok(occ.has(5));
});

test('allocation skips every taken slot and returns the lowest free one', () => {
  const slot = chooseSlot({
    ...base,
    containers: [cont('example-app-s1'), cont('example-app-s2')],
    declarations: [decl('/wt/alpha', 'example-app-s3')],
  });
  assert.equal(slot, 4);
});

// This is the whole point. A registry-first allocator reuses whatever its file
// says and never revalidates, which is how one slot gets handed out twice a week
// apart and two worktrees end up sharing a database.
test('allocation never reuses a slot another config.toml holds, whatever the caller claims', () => {
  const slot = chooseSlot({
    ...base,
    cwd: '/wt/newcomer',
    declarations: [decl('/wt/incumbent', 'example-app-s6')],
    claimed: 6, // the caller's registry file says 6 — a hint, not proof
  });
  assert.notEqual(slot, 6, 'somebody else holds 6; the caller claiming it does not make it free');
});

test('idempotent: an uncontested slot of my own comes back unchanged, ports stay put', () => {
  const slot = chooseSlot({
    ...base,
    cwd: '/wt/alpha',
    declarations: [decl('/wt/alpha', 'example-app-s9')],
    containers: [cont('example-app-s9')],
  });
  assert.equal(slot, 9, 'a repeat call must not renumber — renumbering rebuilds the stack for nothing');
});

test('the main repo is always 0 and never participates in allocation', () => {
  const slot = chooseSlot({ ...base, cwd: MAIN });
  assert.equal(slot, 0);
});

test('returns null when everything is taken, rather than a number that would collide', () => {
  const all = [];
  for (let i = 1; i <= 19; i++) all.push(cont(`example-app-s${i}`));
  assert.equal(chooseSlot({ ...base, containers: all }), null);
});

// cwd is very unlikely to be the worktree root — config.toml lives a few levels
// down. Measured before this was fixed: called from a subdirectory, the main repo
// was handed a non-zero slot (so a script would have rewritten its committed
// config), and an already-allocated worktree was renumbered.
test('ownerRoot resolves a subdirectory to the worktree that owns it', () => {
  const roots = [MAIN, '/repo/.claude/worktrees/nested', '/wt/alpha'];
  assert.equal(ownerRoot('/wt/alpha/apps/web/supabase', roots), '/wt/alpha');
  assert.equal(ownerRoot(MAIN + '/apps/web', roots), MAIN);
});

// Worktrees are often nested inside the main repo. A first-match rule would
// attribute every one of them to the main repo, hand them all slot 0, and pile
// them onto the default project_id.
test('ownerRoot takes the longest prefix so a nested worktree is not swallowed', () => {
  const roots = [MAIN, '/repo/.claude/worktrees/nested'];
  assert.equal(ownerRoot('/repo/.claude/worktrees/nested/apps/web', roots),
    '/repo/.claude/worktrees/nested');
});

test('ownerRoot returns the path unchanged when it is under no worktree', () => {
  assert.equal(ownerRoot('/somewhere/else', [MAIN]), '/somewhere/else');
});

test('ownerRoot respects path boundaries and is not fooled by a sibling with the same prefix', () => {
  assert.equal(ownerRoot('/wt/alpha-2/apps', ['/wt/alpha', '/wt/alpha-2']), '/wt/alpha-2');
  assert.equal(ownerRoot('/wt/alphabet', ['/wt/alpha']), '/wt/alphabet');
});


// Ports are a machine-wide fact while the slot space is per-project. Without
// reconciling the two, a number goes out whose ports are already held, and the
// failure only surfaces later when the stack tries to start. This has nothing to
// do with running multiple projects — one zombie dev server is enough.
test('a slot with any expected port already held cannot be handed out', () => {
  const b = portBlockedSlots({
    ...base,
    blockedPorts: blocked([54511, 'Python']), // slot 19's api port
  });
  assert.ok(b.has(19));
  assert.equal(b.get(19)!.role, 'api');
  assert.equal(b.get(19)!.port, 54511);
});

test('non-supabase roles count too: a held web port also makes the slot unusable', () => {
  const b = portBlockedSlots({ ...base, blockedPorts: blocked([3140, 'node']) }); // slot 4's web port
  assert.equal(b.get(4)?.role, 'web');
});

// Another project's cold stack holds no ports at all, so lsof cannot see it —
// but it will bind them the moment it starts. Measured: six cold slots on one
// machine were in exactly that state. Without counting container-declared ports,
// a second project hands those numbers out and they collide on wake-up.
test('ports declared by another project\'s cold stack count as taken', () => {
  const b = portBlockedSlots({
    ...base,
    blockedPorts: blocked([54411, 'supabase_kong_other-project-s1']),
  });
  assert.equal(b.get(9)?.by, 'supabase_kong_other-project-s1');
});

test('allocation skips a slot whose ports are held', () => {
  const slot = chooseSlot({
    ...base,
    containers: [cont('example-app-s1')],
    blockedPorts: blocked([54341, 'node']), // slot 2's api port
  });
  assert.equal(slot, 3, 'slot 1 has containers, slot 2 is port-blocked, so 3');
});

test('chooseSlot does not reinforce a foreign clone\'s slot', () => {
  const slot = chooseSlot({
    ...base,
    cwd: '/wt/alpha',
    declarations: [decl('/wt/alpha', 'example-app-s9')],
    containers: [{ ...cont('example-app-s9'), name: 'example-app-s9', workDir: '/other/clone' }],
  });
  assert.notEqual(slot, 9, 'workDir is another clone; handing 9 back would share its database');
});

test('chooseSlot still returns mine when the container workDir is this worktree', () => {
  const slot = chooseSlot({
    ...base,
    cwd: '/wt/alpha',
    declarations: [decl('/wt/alpha', 'example-app-s9')],
    containers: [{ ...cont('example-app-s9'), name: 'example-app-s9', workDir: '/wt/alpha' }],
  });
  assert.equal(slot, 9);
});

// My own stack is of course holding my own ports; counting that as "taken" would
// renumber me on every call.
test('the idempotent path is unaffected by my own ports', () => {
  const slot = chooseSlot({
    ...base,
    cwd: '/wt/alpha',
    declarations: [decl('/wt/alpha', 'example-app-s9')],
    blockedPorts: blocked([54411, 'own'], [3190, 'own']), // both belong to slot 9 itself
  });
  assert.equal(slot, 9);
});
