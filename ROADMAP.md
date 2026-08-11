# Roadmap

Short, and the "not doing" list is the more useful half.

## Working today

- **doctor** — the three-way join and its findings. Read-only.
- **alloc** — hand out a slot number that is genuinely free. Writes nothing.
- **wake / sleep** — per-service start/stop, bypassing the silent no-op in
  `supabase start`. Never touches data.
- **Layout discovery** — inferred from `config.toml`, refined by `.slotyard.json`.
- **macOS menu bar app** — Tauri, with a tray badge that turns red on a critical
  finding. The badge is driven from a background thread, not the hidden webview,
  because WebKit freezes timers on a closed panel.

## Next, in order

1. **Live with the findings.** The honest next step is not a feature. Which
   findings get acted on, and which get scrolled past? Anything consistently
   ignored should be downgraded or deleted — leaving it in dilutes the ones that
   matter.
2. **A `post-checkout` hook.** Git hooks are shared across every worktree of a
   repo, so one install covers all of them. This is the natural place to call
   `alloc` when a worktree is created. It needs something that writes
   `config.toml`, which is the trust boundary below.
3. **Stacks other than Supabase.** The `Stack` layer already exists for this. It
   needs a second real implementation before the seam can be trusted.

## The trust boundary

Everything above the line is read-only and needs no trust. Below it, the tool
writes your configuration:

```
doctor, alloc          →  read-only. Available now.
─────────────────────────────────────────────────────
writing config.toml    →  needs the source read first.
env injection             Not built.
```

If it is ever built: environment values go to stdout or through an
`exec -- <cmd>` wrapper. They do not get written into the repo.

## Deliberately not building

| | Because |
|---|---|
| A daemon | A local single-machine tool does not need a resident process. |
| A registry as source of truth | Measured 32% accurate against reality. |
| Leases / heartbeats | Produce "green but broken" state, and cannot see environments they did not start — which is where orphans come from. |
| Automatic deletion | Detection is the hard half and it is done. Deleting data needs a track record this tool has not earned. |
| A shared Postgres with many databases | Measured: ~11% better than free configuration changes, and one `db reset --db-url` destroys the whole instance. |
| Electron | A tool claiming to save you resources cannot ship a UI that eats 150MB to do it. |

See [DECISIONS.md](DECISIONS.md) for the measurements behind these.
