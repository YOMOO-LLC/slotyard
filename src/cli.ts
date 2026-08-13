#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolveLayout } from './layouts/discover.ts';
import { probeContainers, probeWorktrees, probeListeners, probeIdentities, probeVolumes, probeReservedPorts, attachStats, attachWorkDirs } from './probe.ts';
import { readDeclarations } from './declarations.ts';
import { analyze } from './analyze.ts';
import { chooseSlot, occupiedSlots, ownerRoot, portBlockedSlots } from './allocate.ts';
import { render } from './render.ts';
import {
  planWake, planSleep, applyPlan, parseLifecycleArgs, type LifecyclePlan,
} from './lifecycle.ts';
import type { Layout } from './layouts/types.ts';

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);

const HELP = `
slotyard — tell the truth about local parallel dev environments; start/stop on demand

Usage
  slotyard [doctor] [options]        read-only checkup (default)
  slotyard wake  <slot|all> [opts]   start containers that exist but are stopped
  slotyard sleep <slot|all> [opts]   stop sleepable services (never db/auth/kong/rest)
  slotyard alloc [options]           print a slot number nobody is using (writes nothing)

doctor options
  --all      expand every slot (default: only the running ones)
  --json     structured JSON output
  --fast     skip docker stats / identity / port probes (for UI polling, sub-second)

wake / sleep options
  --role R   only these roles (comma separated), e.g. --role realtime,studio
  --all      every slot that can be explained
  --dry-run  print the plan, change nothing
  --json     structured output

alloc options
  --claimed N  prefer N if it is genuinely free (a .wt-slot hint, never trusted)
  --json       structured output: which slots are taken, and which are port-blocked

Notes
  doctor never writes. alloc writes nothing either — it only prints a number,
  so the caller stays in control:  SLOT=$(slotyard alloc)
  Occupancy comes from probing: docker labels, every worktree's config.toml, the
  ports bound right now, and the ports every container declares it will bind
  (including stopped ones) — never from .wt-slot.
  Known limit: a slot another project has declared in config.toml but never
  started is invisible here — nothing on the machine points at it yet. alloc cannot prevent a concurrent race between reading
  and the caller writing — doctor's collision check remains the safety net.
  wake/sleep use docker start/stop, bypassing supabase start's silent no-op on a half-asleep stack.
  sleep whitelist: studio, pg_meta, inbucket, realtime, edge_runtime, storage
`.trim();

if (has('--help') || has('-h') || args[0] === 'help') {
  console.log(HELP);
  process.exit(0);
}

try {
  const cmd = args[0];
  if (cmd === 'alloc') {
    await runAlloc(args.slice(1));
  } else if (cmd === 'wake' || cmd === 'sleep') {
    await runLifecycle(cmd, args.slice(1));
  } else if (cmd === 'doctor') {
    await runDoctor(args.slice(1));
  } else {
    // No subcommand means doctor, so `slotyard --all` keeps working
    await runDoctor(args);
  }
} catch (e: any) {
  console.error(`slotyard: ${e.message}`);
  process.exit(1);
}

async function runDoctor(doctorArgs: string[]) {
  const flag = (f: string) => doctorArgs.includes(f);
  const fast = flag('--fast');
  const cwd = process.cwd();
  const { mainRoot, worktrees } = await probeWorktrees(cwd);
  const resolved = await resolveLayout(mainRoot);
  if (!resolved) throw noLayout();
  const layout = resolved.layout;

  // --fast skips stats (the slow one), the lsof port sweep and the auth inspect.
  // Intended for UI polling. Stats stay off here on purpose: docker is
  // machine-wide, and we only want stats for `mine` after the layout filter.
  const [containers, listeners, declarations, volumes] = await Promise.all([
    probeContainers(layout.stack.labelKey, { stats: false }),
    fast ? Promise.resolve([]) : probeListeners(),
    readDeclarations(worktrees, layout),
    probeVolumes(),
  ]);

  // docker is machine-wide: probeContainers brings back other projects' Supabase
  // containers too. analyze filters internally by slotFromProjectId, but
  // probeIdentities was handed the raw list — and a brand-new empty project would
  // then report nine of ANOTHER project's environments sharing a JWT secret.
  // Narrow once here, so nothing downstream can see foreign containers.
  const mine = containers.filter(c => c.projectId && layout.slotFromProjectId(c.projectId) !== null);

  // workDir even on --fast: inspect of OUR list only, so a foreign clone of the
  // same project_id is not reported as an orphan of this repo. Stats stay gated.
  const identitiesP = fast
    ? Promise.resolve([])
    : probeIdentities(
      mine,
      n => layout.stack.roleFromContainer(n, mine.find(c => c.name === n)?.projectId ?? '') === 'auth',
    );
  const [identities] = await Promise.all([
    identitiesP,
    fast ? Promise.resolve() : attachStats(mine),
    attachWorkDirs(mine),
  ]);

  const { slots, findings } = analyze({
    layout, mainRoot, worktrees, containers: mine, listeners, declarations, identities, volumes,
    pathExists: existsSync,
  });

  if (flag('--json')) {
    console.log(JSON.stringify({
      scannedAt: new Date().toISOString(),
      layout: layout.name,
      repo: mainRoot,
      summary: {
        worktrees: worktrees.length,
        declared: declarations.filter(d => d.intent).length,
        running: slots.filter(s => s.running).length,
        containers: mine.length,
        findings: findings.length,
      },
      slots: slots.map(s => ({
        slot: s.slot,
        projectId: s.projectId,
        // Ports must come from the layout. Consumers (the desktop app) must never
        // apply the formula themselves — it is a per-project convention, and
        // hard-coding it produces wrong links the moment the layout differs.
        ports: layout.expect(s.slot).ports,
        running: s.running,
        sleeping: s.sleeping,
        memMiB: s.memMiB,
        cpuPct: s.cpuPct,
        uptime: s.uptime,
        containers: s.containers.map(c => ({
          name: c.name,
          state: c.state,
          role: layout.stack.roleFromContainer(c.name, s.projectId),
        })),
        volumes: s.volumes,
        claimants: s.claimants.map(c => c.worktree.path),
      })),
      findings,
    }, null, 2));
    return;
  }

  process.stdout.write(render({
    layout,
    repoName: mainRoot.split('/').filter(Boolean).pop() ?? mainRoot,
    slots, findings, declarations, worktrees,
    all: flag('--all'),
  }) + '\n');

  if (findings.some(f => f.severity === 'critical')) process.exitCode = 2;
}

async function runAlloc(rest: string[]) {
  const claimedIdx = rest.indexOf('--claimed');
  const claimed = claimedIdx >= 0 ? Number(rest[claimedIdx + 1]) : undefined;
  if (claimedIdx >= 0 && !Number.isInteger(claimed)) {
    throw new Error('--claimed requires a slot number');
  }
  const { mainRoot, worktrees } = await probeWorktrees(process.cwd());
  const resolved = await resolveLayout(mainRoot);
  if (!resolved) throw noLayout();
  const layout = resolved.layout;

  // Being called from somewhere below the worktree root is the normal case.
  // Resolve to the owning worktree first, or the main repo gets a non-zero slot
  // and an already-allocated worktree gets renumbered.
  const cwd = ownerRoot(process.cwd(), [mainRoot, ...worktrees.map(w => w.path)]);

  // Two port sources, and neither is optional:
  //   lsof                 what is listening right now (zombie dev servers,
  //                        anything not running under docker)
  //   container bindings   what is not running but will bind the moment it starts
  //                        (another project's cold stack)
  // Checking only the first hands another project's cold slots out as free.
  const [containers, declarations, listeners, reserved] = await Promise.all([
    probeContainers(layout.stack.labelKey, { stats: false }),
    readDeclarations(worktrees, layout),
    probeListeners(),
    probeReservedPorts(),
  ]);
  // workDir on this layout's containers: alloc must not hand back a slot whose
  // stack lives in another clone. Inspect of the filtered list only.
  await attachWorkDirs(
    containers.filter(c => c.projectId && layout.slotFromProjectId(c.projectId) !== null),
  );
  const blockedPorts = new Map(reserved);
  for (const l of listeners) {
    // Ports bound by docker are covered by the container-binding source, which
    // carries the container name and is therefore more useful in the message.
    if (l.command.startsWith('com.docke') || l.command.startsWith('docker')) continue;
    if (!blockedPorts.has(l.port)) blockedPorts.set(l.port, l.command);
  }
  const input = { layout, mainRoot, containers, declarations, blockedPorts, cwd, claimed };
  const slot = chooseSlot(input);

  if (rest.includes('--json')) {
    console.log(JSON.stringify({
      slot,
      projectId: slot == null ? null : layout.expect(slot).projectId,
      ports: slot == null ? null : layout.expect(slot).ports,
      occupied: [...occupiedSlots(input)].sort((a, b) => a - b),
      portBlocked: Object.fromEntries(
        [...portBlockedSlots(input)].sort((a, b) => a[0] - b[0]),
      ),
      maxSlot: layout.maxSlot,
    }, null, 2));
    if (slot == null) process.exitCode = 1;
    return;
  }

  if (slot == null) {
    throw new Error(
      `all ${layout.maxSlot} slots are taken or port-blocked — see slotyard alloc --json`,
    );
  }
  // stdout is the number and nothing else, so `SLOT=$(slotyard alloc)` works
  console.log(String(slot));
}

async function runLifecycle(action: 'wake' | 'sleep', rest: string[]) {
  const parsed = parseLifecycleArgs(rest);
  const cwd = process.cwd();
  const { mainRoot, worktrees } = await probeWorktrees(cwd);
  const resolved = await resolveLayout(mainRoot);
  if (!resolved) throw noLayout();
  const layout = resolved.layout;

  // wake / sleep need neither stats nor lsof — just the container list
  const containers = await probeContainers(layout.stack.labelKey, { stats: false });
  const plan = action === 'wake'
    ? planWake({ layout, containers, slots: parsed.slots, roles: parsed.roles })
    : planSleep({ layout, containers, slots: parsed.slots, roles: parsed.roles });

  if (parsed.json) {
    const result = parsed.dryRun ? null : await applyPlan(plan);
    console.log(JSON.stringify({
      action,
      dryRun: parsed.dryRun,
      plan: {
        targets: plan.targets,
        skipped: plan.skipped,
      },
      result,
    }, null, 2));
    if (result?.failed.length) process.exitCode = 1;
    return;
  }

  printPlan(plan, parsed.dryRun);

  if (plan.targets.length === 0) {
    process.exitCode = plan.skipped.some(s => s.startsWith('refused')) ? 1 : 0;
    return;
  }

  if (parsed.dryRun) return;

  const result = await applyPlan(plan);
  for (const name of result.ok) {
    const t = plan.targets.find(x => x.name === name)!;
    console.log(`  ✓ ${action === 'wake' ? 'started' : 'stopped'}  SLOT=${t.slot} ${t.role}  ${name}`);
  }
  for (const f of result.failed) {
    console.error(`  ✗ ${f.name}: ${f.error}`);
  }
  if (result.failed.length) process.exitCode = 1;
  else if (action === 'wake') {
    console.log(`\n  ${result.ok.length} total. If a service is still unreachable: docker logs <name>`);
  }
}

function printPlan(plan: LifecyclePlan, dryRun: boolean) {
  const verb = plan.action === 'wake' ? 'start' : 'stop';
  if (plan.targets.length === 0) {
    console.log(`Nothing to ${verb}.`);
    for (const s of plan.skipped.slice(0, 8)) console.log(`  · ${s}`);
    return;
  }
  console.log(`${dryRun ? '[dry-run] would ' : 'will '}${verb} ${plan.targets.length} container${plan.targets.length > 1 ? 's' : ''}:`);
  for (const t of plan.targets) {
    console.log(`  SLOT=${t.slot}  ${t.role.padEnd(14)}  ${t.state}  →  ${t.name}`);
  }
  if (dryRun) console.log('\n(--dry-run: nothing executed)');
}

function noLayout(): Error {
  return new Error(
    'No matching layout.\n' +
    "  slotyard needs this project's slot conventions (port formula, project_id naming).\n" +
    '  It looks for, in order:\n' +
    '    1. .slotyard.json at the repo root\n' +
    "    2. a supabase config.toml to infer from\n" +
    '  Neither was found. Add .slotyard.json with "prefix", "configPath" and "ports".',
  );
}

