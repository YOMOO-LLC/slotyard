// How a new project gets recognised. Two levels, and most projects stop at 0.
//
//   0  zero config     — inferred from supabase's config.toml: prefix, base
//                        ports, and where the file lives
//   1  .slotyard.json  — supply what cannot be inferred (the app's own web /
//                        metro ports) and override defaults
//
// There is deliberately no "built-in layout" tier. A built-in hard-codes one
// project's naming into the tool, and every other project then looks like a
// special case.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { makeLayout, mergeSpec, parseSupabaseConfig, type LayoutSpec } from './make.ts';
import type { Layout } from './types.ts';

const CONFIG_NAME = '.slotyard.json';

/**
 * Common placements. Deliberately not a recursive walk: node_modules is full of
 * config.toml files, and scanning for them would be both slow and wrong.
 */
async function findConfigPath(root: string): Promise<string | null> {
  for (const p of ['supabase/config.toml', 'apps/web/supabase/config.toml']) {
    if (await exists(join(root, p))) return p;
  }
  for (const dir of ['apps', 'packages']) {
    for (const sub of await listDir(join(root, dir))) {
      const p = `${dir}/${sub}/supabase/config.toml`;
      if (await exists(join(root, p))) return p;
    }
  }
  return null;
}

/** Level 0: everything derivable from config.toml alone */
async function inferSpec(root: string, configPath?: string): Promise<LayoutSpec | null> {
  const path = configPath ?? await findConfigPath(root);
  if (!path) return null;
  const content = await readMaybe(join(root, path));
  if (content === null) return null;
  const parsed = parseSupabaseConfig(content);
  if (!parsed) return null;
  return {
    name: `${parsed.projectId} (inferred)`,
    prefix: parsed.projectId,
    configPath: path,
    ports: parsed.ports,
  };
}

/** Level 1: .slotyard.json at the repo root. Every field optional, merged on
 *  top of what was inferred. */
async function readUserConfig(root: string): Promise<Partial<LayoutSpec> | null> {
  const raw = await readMaybe(join(root, CONFIG_NAME));
  if (raw === null) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`${CONFIG_NAME} is not valid JSON: ${e.message}`);
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  throw new Error(`${CONFIG_NAME} must contain a JSON object`);
}


export type Resolved = { layout: Layout; source: 'config' | 'inferred' };

export async function resolveLayout(root: string): Promise<Resolved | null> {
  const user = await readUserConfig(root);

  if (user) {
    const inferred = await inferSpec(root, user.configPath);
    const base = inferred ?? blankSpec(user);
    if (!base) {
      throw new Error(
        `${CONFIG_NAME} found, but no supabase config.toml to build on.\n` +
        '  Set "configPath", "prefix" and "ports" explicitly.',
      );
    }
    const spec = mergeSpec(base, user);
    return { layout: makeLayout({ ...spec, name: `${spec.prefix} (${CONFIG_NAME})` }), source: 'config' };
  }

  const inferred = await inferSpec(root);
  return inferred ? { layout: makeLayout(inferred), source: 'inferred' } : null;
}

/** With no config.toml to build on, the user must supply all three basics —
 *  there is nothing to infer from. */
function blankSpec(user: Partial<LayoutSpec>): LayoutSpec | null {
  if (!user.prefix || !user.configPath || !user.ports) return null;
  return { name: user.prefix, prefix: user.prefix, configPath: user.configPath, ports: user.ports };
}

async function exists(p: string): Promise<boolean> {
  return (await readMaybe(p)) !== null;
}

async function listDir(p: string): Promise<string[]> {
  try {
    return (await readdir(p, { withFileTypes: true }))
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name);
  } catch {
    return [];
  }
}

async function readMaybe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
