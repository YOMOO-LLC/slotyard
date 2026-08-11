# CLAUDE.md

Guidance for Claude Code (claude.ai/code) and anyone else working in this repo.

slotyard tells the truth about local parallel dev environments: **doctor does not
lie / nothing silently shares a database**, and **wake/sleep start and stop on
demand**. The through-line is always "what actually exists on this machine right
now, and which of it is quietly contaminating something else".

Read [DECISIONS.md](DECISIONS.md) before changing behaviour. Most of what looks
arbitrary here is a bug that shipped once.

## Development: tests first

**Write the test, then the implementation.** Not the other way round.

```bash
node --test src/analyze.test.ts                   # one file
node --test src/*.test.ts src/layouts/*.test.ts   # all of them
```

There is no `npm test` — do not go looking for one in package.json.

**Which layer gets unit tests, and which does not:**

| Layer | Unit tested? | How it is verified |
|---|---|---|
| `analyze.ts` · `allocate.ts` · `lifecycle.ts` · `layouts/` | **Required** | Pure functions and planning logic. New checks or rules get a test first. |
| `render.ts` | No | Pure formatting. Verified by looking at it. |
| `probe.ts` · `declarations.ts` · `applyPlan` | **No unit tests** | They touch real docker/lsof/git. Mocking them would be testing the mocks. |

The probe layer is covered by a fixture instead (~15 seconds, needs docker):

```bash
test/e2e.sh     # 12 assertions: the join, each finding, alloc, cross-project
```

**Do not use somebody's working environment as a test bed.** Five bugs in the
probe layer were once found by hand, and the cost was creating orphans, starting
real stacks and rewriting worktree configs on a machine in active use — one of
those experiments caused a real slot collision. The fixture uses a dedicated
prefix and port range, and creates containers without starting them, so it holds
no ports and disturbs nothing.

Tests use `node:test` + `node:assert/strict` only. **Do not add jest or vitest** —
it would break the zero-dependency guarantee.

## Hard constraints

**Zero build, zero dependencies.** Node 22 strips types natively and runs `.ts`
directly. Do not add tsc, tsx or a bundler. Do not `npm install` anything —
`dependencies` must stay empty.

**doctor is read-only.** `slotyard` / `slotyard doctor` must never perform a
docker write. `alloc` is read-only too: it prints a number and writes no file.

**wake/sleep are the explicit write path**, and only ever `docker start|stop` on
containers that already exist. The sleep whitelist excludes db/auth/kong/rest and
no flag may override that. Never `docker rm`, never prune, never touch a volume.

## Four rules the architecture depends on

Break any of these and the product's proposition is gone.

**1. Truth comes from probing, not from declaration files.**
`docker ps` / `lsof` / the filesystem / `git worktree list` are the sources of
truth. A registry file is a *third view*, used only to compare against reality
and surface drift. Measured 32% accurate. Treating it as truth would make this
tool exactly as wrong as the problem it claims to eliminate.

**2. The abstraction splits between stack and project, not between stacks.**
- `Stack` (`layouts/types.ts`) — the tech stack, e.g. supabase's official label
  `com.supabase.cli.project`. Stable, shared, few.
- `Layout` — the project's conventions: port formula, `project_id` naming. One
  per project, and it comes from the repo, not from this codebase.

`base + slot*10` is one project's choice, not a rule of Supabase — which is why
it lives in a Layout. **Do not split by tech stack** (`SupabaseAdapter` /
`NextjsAdapter`): that leaves nowhere to put the differences *between* projects.

**2b. docker is machine-wide; every global query must be narrowed by layout.**
`probeContainers` returns other projects' containers too. This has leaked twice:
layout selection scored by container count and matched a foreign project's
layout; the identity check received an unfiltered list and reported another
project's environments. **The only evidence that a container is ours is that one
of this repo's worktrees declares its `project_id`.** Never counts.

**3. Attribution rules are settled by measurement — do not revert them to
intuition.**
- Process ownership uses `lsof -d cwd`, **not PPID** — a PPID can become 1 within
  two seconds, and using it condemns healthy processes.
- Slot ownership uses `config.toml`'s `project_id` (what the CLI actually reads),
  **not the registry file** (intent ≠ effective), and **never a reversed hash**
  (allocators probe linearly past collisions, so the hash is only a starting
  point).

## Connecting a project

Two levels: `.slotyard.json` at the repo root, otherwise inferred from supabase's
`config.toml`. Both go through the same `makeLayout` factory — there is no
built-in tier, because a built-in hard-codes one project's naming and makes every
other project a special case.

**A spec declares conventions, not state.** The port formula is a decision and
belongs in a file. "Slot 7 is held by X" is an observable fact and must be
probed. **Never add an `assignments` field** — that single step turns this tool
into the thing it exists to eliminate.

## Writing a finding

The `confidence` field is mandatory. Uncertainty goes in the data structure, not
into hedged wording. Attribution accuracy is the whole value here: misjudge
somebody's process once and they uninstall.

Severity is graded by **harm**, not by type. Anything that can silently cross
databases is `critical`/`warning`. Anything that cannot affect data correctness
(studio / metro / inbucket ports) is `info`. Reporting the lowest-harm thing at
the highest volume trains people to ignore a whole category.

Route count strings through the `s(n)` helper in `analyze.ts`. A report that says
`1 worktrees` makes the reader doubt every other number in it.

## Language

**All user-facing text is English** — CLI output, `--help`, the desktop UI, error
messages. Code comments, docs and commit messages too.

Worktree names and paths are **data, not copy**, and are passed through verbatim
in whatever language they are written in. This is why the wide-character
alignment logic in `render.ts` cannot be deleted: a CJK worktree name skews the
whole table without it.

## Safety when debugging

This tool runs against real environments people are working in.

- Never `docker stop|rm|kill` a container you did not create, unless explicitly
  asked to verify `wake`/`sleep`
- Never `docker system prune` / `volume prune` / `container prune`
- Build test environments with a dedicated `project_id` prefix and port range,
  and clean up after yourself — `test/e2e.sh` is the worked example
- Prefer `--dry-run` for lifecycle experiments, and restore with `wake` afterwards
  so nothing is left half-asleep
