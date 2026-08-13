// node --test src/layouts/make.test.ts
// A Layout is a spec that can be inferred or declared, rather than a hard-coded
// TypeScript file. Two pieces of pure logic are tested here: deriving a spec
// from config.toml, and building a Layout out of a spec.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLayout, parseSupabaseConfig, mergeSpec, type LayoutSpec } from './make.ts';
import { exampleLayout } from './example.ts';

const CONFIG = `
project_id = "my-app"

[api]
enabled = true
port = 54321
schemas = ["public"]

[db]
port = 54322
major_version = 15

[db.pooler]
port = 54329

[studio]
port = 54323

[inbucket]
port = 54324
smtp_port = 54325
pop3_port = 54326
`;

test('parseSupabaseConfig reads project_id and the first port in each section', () => {
  const c = parseSupabaseConfig(CONFIG);
  assert.equal(c!.projectId, 'my-app');
  assert.deepEqual(c!.ports, {
    api: 54321, db: 54322, studio: 54323, inbucket: 54324, smtp: 54325, pop3: 54326,
  });
});

// A sub-section's port must not overwrite its parent's: section names have to
// match exactly, not by prefix.
test('parseSupabaseConfig does not let a sub-section pollute its parent', () => {
  const c = parseSupabaseConfig(CONFIG);
  assert.equal(c!.ports.db, 54322, '[db.pooler] 54329 must not overwrite [db]');
});

test('parseSupabaseConfig returns null for anything that is not a supabase config', () => {
  assert.equal(parseSupabaseConfig('name = "x"\n[foo]\nport = 1'), null);
});

const spec: LayoutSpec = {
  name: 'my-app',
  prefix: 'my-app',
  configPath: 'supabase/config.toml',
  ports: { api: 54321, db: 54322, web: 3000 },
};

test('makeLayout maps the bare prefix to slot 0', () => {
  const l = makeLayout(spec);
  assert.equal(l.slotFromProjectId('my-app'), 0);
  assert.equal(l.slotFromProjectId('my-app-s7'), 7);
  assert.equal(l.slotFromProjectId('other-app-s7'), null);
});

test('makeLayout rejects slots past maxSlot, or foreign containers get counted in', () => {
  const l = makeLayout({ ...spec, maxSlot: 5 });
  assert.equal(l.slotFromProjectId('my-app-s5'), 5);
  assert.equal(l.slotFromProjectId('my-app-s6'), null);
});

test('makeLayout escapes regex metacharacters in the prefix', () => {
  const l = makeLayout({ ...spec, prefix: 'a.b+c' });
  assert.equal(l.slotFromProjectId('a.b+c-s3'), 3);
  assert.equal(l.slotFromProjectId('aXbXc-s3'), null, '"." must not match any character');
});

test('makeLayout resolves a port back to slot and role', () => {
  const l = makeLayout(spec);
  assert.deepEqual(l.slotFromPort(54341), { slot: 2, role: 'api' });
  assert.deepEqual(l.slotFromPort(3020), { slot: 2, role: 'web' });
  assert.equal(l.slotFromPort(54325), null, 'not on any base port step');
  assert.equal(l.slotFromPort(54311), null, 'a negative slot must not be read as 0');
});

test('expect and slotFromPort are inverses of each other', () => {
  const l = makeLayout(spec);
  for (const s of [0, 1, 9, 19]) {
    const { ports, projectId } = l.expect(s);
    assert.equal(l.slotFromProjectId(projectId), s);
    for (const [role, port] of Object.entries(ports)) {
      assert.deepEqual(l.slotFromPort(port), { slot: s, role });
    }
  }
});

test('makeLayout copies fixUp through from the spec', () => {
  const l = makeLayout({ ...spec, fixUp: './tools/up.sh' });
  assert.equal(l.fixUp, './tools/up.sh');
  assert.equal(makeLayout(spec).fixUp, undefined);
});

test('mergeSpec lets explicit config win, and merges ports rather than replacing', () => {
  const m = mergeSpec(
    { name: 'i', prefix: 'my-app', configPath: 'a', ports: { api: 54321, db: 54322 } },
    { ports: { web: 3000 }, maxSlot: 9 },
  );
  assert.deepEqual(m.ports, { api: 54321, db: 54322, web: 3000 }, 'inferred ports must survive the merge');
  assert.equal(m.maxSlot, 9);
  assert.equal(m.prefix, 'my-app');
});

// The reference layout goes through exactly the same factory as any user's
// config. Its behaviour is pinned bit for bit, because a regression here is a
// slot collision on somebody's machine.
test('regression: the reference layout behaves exactly as specified', () => {
  assert.equal(exampleLayout.slotFromProjectId('example-app'), 0);
  assert.equal(exampleLayout.slotFromProjectId('example-app-s9'), 9);
  assert.equal(exampleLayout.slotFromProjectId('example-app-s20'), null);
  assert.equal(exampleLayout.maxSlot, 19);
  assert.deepEqual(exampleLayout.expect(9).ports, {
    api: 54411, db: 54412, studio: 54413, inbucket: 54414, smtp: 54415, pop3: 54416,
    web: 3190, metro: 8171,
  });
  assert.equal(exampleLayout.expect(0).projectId, 'example-app');
  assert.deepEqual(exampleLayout.slotFromPort(54411), { slot: 9, role: 'api' });
  assert.deepEqual(exampleLayout.slotFromPort(3190), { slot: 9, role: 'web' });
  assert.deepEqual(exampleLayout.slotFromPort(8171), { slot: 9, role: 'metro' });
  assert.equal(exampleLayout.configPath, 'apps/web/supabase/config.toml');
});
