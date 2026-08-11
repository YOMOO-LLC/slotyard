# Decisions

Why things are the way they are. Every entry here cost something to learn — most
of them are bugs that shipped, got measured, and forced a rule.

## Truth comes from probing, never from a declaration file

A registry file records what somebody *intended*. It goes stale the moment
anything happens outside the tool that writes it — a manual edit, an interrupted
script, a directory deleted by hand. Measured on one real machine, the registry
file agreed with reality **32% of the time**.

So ownership is decided by two probed sources only:

- container labels (`com.supabase.cli.project`)
- the `project_id` in each worktree's `config.toml` — the value the supabase CLI
  actually reads at startup

The registry file is still read, but only as a third view. Its entire job is to
make `intent-drift` visible: "you think you are on slot 9, the CLI is reading
slot 15."

A tool that trusted the registry would be exactly as wrong as the registry, while
sounding authoritative. That is worse than not existing.

## Attribution rules that contradict intuition

Both of these were tried the obvious way first, and both were wrong.

**Process ownership uses `lsof -d cwd`, not PPID.** A process's PPID can become
1 within two seconds of starting. Using it to decide "orphan" condemns healthy
processes. `cwd` points straight at the worktree.

**Slot ownership never reverse-engineers a hash.** Allocators commonly derive a
starting slot from `hash(name) % N`, then linearly probe past collisions. The
hash is a *starting point*, not the answer — reversing it gives you the slot the
worktree would have had if nothing else had been in the way.

## Severity is graded by harm, not by type

Anything that can silently cross databases is `critical` or `warning`. Anything
that cannot affect data correctness — studio, metro, inbucket ports — is `info`,
however alarming it looks.

Reporting the lowest-harm thing at the highest volume trains people to ignore an
entire category of alert. Once that happens the tool is worse than silent,
because the one that mattered scrolls past with the rest.

Every finding also carries an explicit `confidence` field. Uncertainty belongs in
the data structure, not in hedged wording. Attribution accuracy is this tool's
whole value: misjudge somebody's process once and they uninstall it.

## The allocator only ever hands out a number

Deciding *which slot is free* and *writing the config* are separate jobs with
different trust requirements. A read-only tool does not need to be trusted. A
tool that rewrites your `config.toml` and `.env` needs its source read first.

So `alloc` prints one number to stdout and writes nothing. The caller stays in
control, and adopting it is a one-line change.

**It cannot prevent a race, and says so.** There is a window between reading and
the caller writing. Callers creating worktrees in parallel must lock across both
steps — locking only the allocation achieves nothing, because the window is
between them. Measured: five concurrent calls all returned the same number.

The collision check therefore stays a safety net rather than redundancy.

## Occupancy has to include ports, from two sources

An early version decided occupancy from containers and declarations alone.
Measured failure: with a process holding one port, the allocator still handed out
that slot, and the failure surfaced much later when the stack tried to start.

Two port sources, neither optional:

- **what is listening now** (`lsof`) — zombie dev servers, anything not under
  docker
- **what every container declares it will bind** (`docker inspect`) — including
  stopped ones

The second matters more than it looks. A cold stack holds no ports at all, so
`lsof` cannot see it, but it grabs them the instant it starts. On one machine six
cold slots were in exactly that state; without the second source a second project
would have been handed all six as free.

The port check is deliberately not filtered by layout. Ports are a machine-wide
resource, and this is the only way two projects coexist without the user
configuring anything.

## Global docker queries must be narrowed by layout

docker is machine-wide. Any query returns other projects' containers, and that
leaked twice:

- layout selection scored by counting containers, so running the tool inside an
  unrelated repo matched a *different* project's layout and reported its
  environments as unclaimed
- the identity check received the unfiltered container list, so a brand-new empty
  project reported nine of another project's environments sharing a JWT secret

The rule that came out of it: the only evidence that a container belongs to this
repo is that one of this repo's worktrees declares its `project_id`. Never
container counts.

## No built-in layouts

A built-in layout hard-codes one project's naming into the tool, and every other
project then looks like a special case. Layouts come from the repo itself —
inferred from `config.toml`, refined by `.slotyard.json`.

The abstraction splits in a specific place:

- **Stack** — the tech stack. How to recognise one stack inside docker. Stable,
  shared, few of them.
- **Layout** — the project's own conventions. Port formula, `project_id` naming.
  One per project.

Do *not* split by tech stack instead (`SupabaseAdapter` / `NextjsAdapter`): that
leaves nowhere to put the differences *between* projects, which is where all the
variation actually lives.

## Deletion order is fixed, and the tool never runs it

For an orphaned environment the suggested commands are, always: inspect first,
then containers, then volumes.

Those exited containers are the only thing currently keeping the volumes
referenced. Removing volumes first — or removing containers and then running a
prune — destroys data that `docker volume prune` would otherwise never have
touched.

slotyard executes none of it. It finds the orphan and hands you the command.

## The probe layer is tested against real docker, not mocks

Mocking docker, lsof and git would be testing the mocks. But "verify on a real
machine" in practice meant experimenting on a machine somebody was working on:
creating orphans, starting real stacks, rewriting worktree configs. Five bugs in
this layer were found that way in a single day, and one of those experiments
caused a real collision.

`test/e2e.sh` builds a throwaway fixture instead — its own prefix, its own port
range, containers created but never started so no port is actually held, and
`trap EXIT` cleanup verified to leave nothing behind after a mid-run kill.

Containers are `busybox`, not supabase. slotyard only reads labels, port bindings
and container state; it has no opinion about what runs inside. Nine busybox
containers take a second, a real stack takes thirty.

## Counts are pluralised

A report that says `1 worktrees` makes the reader start doubting every other
number in it. When a tool's entire proposition is that its numbers are true, that
is not a cosmetic problem.

## What is deliberately absent

| Not built | Because |
|---|---|
| A daemon | A local single-machine tool does not need a resident process. Probing on demand is enough. |
| A registry as source of truth | Measured 32% accurate. See the first section. |
| Leases / heartbeats | They produce "green but broken" state, and cannot see environments they did not start — which is where orphans come from. Idle detection uses observable facts instead. |
| Automatic deletion | Deleting data needs a track record this tool has not earned. Detection is the hard half and it is done; the destructive half can wait. |
| Electron for the desktop app | A tool that claims to save you resources cannot ship a UI that eats 150MB to do it. Tauri only. |
