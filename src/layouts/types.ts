// Two layers of abstraction:
//   Stack  — the tech stack. How to recognise "one stack" inside docker.
//            Stable, shared, few of them.
//   Layout — the project's conventions. The mapping between slot number,
//            project_id and ports. One per project.
//
// The split comes from what is actually observable: the supabase CLI stamps an
// official label `com.supabase.cli.project` (stack layer), whereas
// `54321 + slot*10` and `myapp-s{N}` are one project's own choice (layout layer).
//
// Do NOT split by tech stack instead (SupabaseAdapter / NextjsAdapter) — then
// there is nowhere left to put the differences *between* projects.

export type Stack = {
  name: string;
  /** The docker label key whose value is the project id */
  labelKey: string;
  /** Recognise the service role from a container name, e.g. supabase_db_xxx -> "db" */
  roleFromContainer(name: string, projectId: string): string | null;
  /** Whether a docker volume belongs to a given project_id */
  volumeBelongsTo(volumeName: string, projectId: string): boolean;
};

export type Layout = {
  name: string;
  stack: Stack;

  /** Slot number from a project id; null when it is not ours */
  slotFromProjectId(projectId: string): number | null;
  /** Slot and role from a listening port; null when it is not ours */
  slotFromPort(port: number): { slot: number; role: string } | null;
  /** Forward direction: what this slot should look like. Used for checking and
   *  for showing collapsed rows. */
  /** Where config.toml sits, relative to the repo root. Projects lay this out
   *  differently, so it belongs to the project's conventions, not the stack's. */
  configPath: string;
  /** Highest slot this project supports. How wide the port range is, is the
   *  project's own choice — nothing to do with the stack. */
  maxSlot: number;
  expect(slot: number): { projectId: string; ports: Record<string, number> };

  /** The third view: the repo's declaration file. Only used to surface drift,
   *  never treated as truth. */
  registry: {
    file: string;
    parse(content: string): { slot: number; ports: Record<string, number>; projectId?: string } | null;
  };

};

export const SUPABASE_STACK: Stack = {
  name: 'supabase',
  labelKey: 'com.supabase.cli.project',
  roleFromContainer(name, projectId) {
    // supabase_db_<projectId> / supabase_edge_runtime_<projectId> ...
    const m = new RegExp(`^supabase_(.+)_${escapeRe(projectId)}$`).exec(name);
    return m ? m[1] : null;
  },
  // Observed volume names: supabase_db_<projectId> / supabase_storage_<projectId> …
  // endsWith, so the default id (no -sN suffix) does not swallow its suffixed siblings.
  volumeBelongsTo(volumeName, projectId) {
    return volumeName.endsWith(projectId);
  },
};

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
