# slotyard desktop (macOS menu bar)

Menu bar Status Item + Liquid Glass panel. Spawns the monorepo CLI (`src/cli.ts`) for truth.

## Dev

```bash
cd desktop
npm install
npm run dev
```

- No Dock icon (Accessory).
- Click the tray icon to open the panel.
- Right-click tray: Open panel / Refresh / Quit.
- Choose the repo folder via ⋯. Any repo slotyard can resolve a layout for works.

## Requirements

- Node ≥ 22.18 (for `node --experimental-strip-types src/cli.ts`)
- Rust / Cargo
- Docker (for doctor probes)

## Architecture

```
Tray click → panel window (380×520, transparent)
  → invoke run_doctor → node …/src/cli.ts --json
  → render slots / findings
  → wake/sleep → node …/src/cli.ts wake|sleep N
```
