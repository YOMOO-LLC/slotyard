import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exampleLayout } from './layouts/example.ts';
import type { Container } from './probe.ts';
import { planWake, planSleep, parseLifecycleArgs, SLEEPABLE_ROLES } from './lifecycle.ts';

function c(
  projectId: string,
  role: string,
  state: Container['state'] = 'running',
): Container {
  return {
    name: `supabase_${role}_${projectId}`,
    projectId,
    uptime: '',
    memMiB: null,
    cpuPct: null,
    state,
  };
}

const pid = (n: number) => `example-app-s${n}`;

test('planWake starts only non-running containers, filtered by slot and role', () => {
  const containers = [
    c(pid(17), 'db', 'running'),
    c(pid(17), 'realtime', 'exited'),
    c(pid(17), 'studio', 'exited'),
    c(pid(3), 'realtime', 'exited'),
  ];

  const all = planWake({ layout: exampleLayout, containers, slots: [17] });
  assert.deepEqual(all.targets.map(t => t.role).sort(), ['realtime', 'studio']);
  assert.ok(all.targets.every(t => t.slot === 17));

  const onlyRt = planWake({ layout: exampleLayout, containers, slots: [17], roles: ['realtime'] });
  assert.deepEqual(onlyRt.targets.map(t => t.role), ['realtime']);

  const none = planWake({
    layout: exampleLayout,
    containers: [c(pid(17), 'db', 'running')],
    slots: [17],
  });
  assert.equal(none.targets.length, 0);
  assert.ok(none.skipped.some(s => /already running/.test(s)));
});

test('planSleep touches only sleepable roles; core services never become targets', () => {
  const containers = [
    c(pid(17), 'db', 'running'),
    c(pid(17), 'auth', 'running'),
    c(pid(17), 'studio', 'running'),
    c(pid(17), 'realtime', 'running'),
    c(pid(17), 'inbucket', 'exited'),
  ];

  const plan = planSleep({ layout: exampleLayout, containers, slots: [17] });
  assert.deepEqual(plan.targets.map(t => t.role).sort(), ['realtime', 'studio']);
  assert.ok(!plan.targets.some(t => t.role === 'db' || t.role === 'auth'));

  const refuse = planSleep({
    layout: exampleLayout,
    containers,
    slots: [17],
    roles: ['db'],
  });
  assert.equal(refuse.targets.length, 0);
  assert.ok(refuse.skipped.some(s => /refused/.test(s)));
});

test('the sleepable whitelist matches what was measured safe to stop', () => {
  for (const r of ['studio', 'pg_meta', 'inbucket', 'realtime', 'edge_runtime', 'storage']) {
    assert.ok(SLEEPABLE_ROLES.has(r));
  }
  for (const r of ['db', 'kong', 'rest', 'auth']) {
    assert.ok(!SLEEPABLE_ROLES.has(r));
  }
});

test('parseLifecycleArgs', () => {
  assert.deepEqual(parseLifecycleArgs(['17']), {
    slots: [17], roles: [], all: false, dryRun: false, json: false,
  });
  assert.deepEqual(parseLifecycleArgs(['--all', '--role', 'studio,realtime', '--dry-run']), {
    slots: [], roles: ['studio', 'realtime'], all: true, dryRun: true, json: false,
  });
  assert.throws(() => parseLifecycleArgs([]), /slot/);
  assert.throws(() => parseLifecycleArgs(['--role']), /requires an argument/);
});
