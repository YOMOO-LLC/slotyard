import type { Finding, SlotView } from './analyze.ts';
import { fmtMem } from './analyze.ts';
import type { Declaration } from './declarations.ts';
import type { Worktree } from './probe.ts';
import type { Layout } from './layouts/types.ts';

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => c('2', s);
const bold = (s: string) => c('1', s);
const red = (s: string) => c('31', s);
const yellow = (s: string) => c('33', s);
const green = (s: string) => c('32', s);

export function render(opts: {
  layout: Layout;
  repoName: string;
  slots: SlotView[];
  findings: Finding[];
  declarations: Declaration[];
  worktrees: Worktree[];
  all: boolean;
}): string {
  const { layout, repoName, slots, findings, declarations, worktrees, all } = opts;
  const L: string[] = [];
  const name = (p: string) => p.split('/').filter(Boolean).pop() ?? p;

  L.push('');
  L.push(`${bold('slotyard')} · ${repoName}${dim(`                    layout: ${layout.name}`)}`);
  L.push('');

  // ── Slot list: running ones expanded, the rest folded away ──────
  const shown = all ? slots : slots.filter(s => s.running);
  if (shown.length > 0) {
    L.push(dim(' SLOT  WORKTREE                          APP    API     RAM      CPU     UP'));
    for (const s of shown) {
      const owner = s.claimants.length === 0
        ? dim('?')
        : s.claimants.length === 1
          ? name(s.claimants[0].worktree.path)
          : red(`${s.claimants.length} claimants`);
      const p = layout.expect(s.slot).ports;
      const mark = s.claimants.length === 0 && s.running ? yellow('  ⚠ unclaimed')
        : s.slot === 0 && s.claimants.length > 1 ? yellow('  ⚠ unallocated')
        : s.claimants.length > 1 ? red('  ⚠ collision')
        : s.sleeping.length > 0 ? dim(`  💤 ${s.sleeping.join(',')}`)
        : '';
      L.push(
        `  ${String(s.slot).padStart(2)}   ${pad(owner, 32)} ` +
        `${String(p.web ?? '').padEnd(6)} ${String(p.api ?? '').padEnd(7)} ` +
        `${(s.memMiB ? fmtMem(s.memMiB) : '-').padEnd(8)} ` +
        `${(s.cpuPct != null ? s.cpuPct.toFixed(1) + '%' : '-').padEnd(7)} ` +
        `${fmtUptime(s.uptime).padEnd(5)}${mark}`,
      );
    }
    L.push(dim(' ' + '─'.repeat(78)));
  } else {
    L.push(dim('  No environments running'));
  }

  const runningCount = slots.filter(s => s.running).length;
  const totalMem = slots.reduce((a, s) => a + (s.memMiB ?? 0), 0);
  const declared = declarations.filter(d => d.intent).length;
  const noDecl = worktrees.length - declarations.filter(d => d.effective).length;
  L.push(
    `  ${runningCount} running${totalMem ? ' · ' + fmtMem(totalMem) : ''}` +
    dim(`          ${declared} declared · ${worktrees.length} worktrees` +
      (noDecl > 0 ? ` · ${noDecl} unconfigured` : '') + (all ? '' : '          --all to expand')),
  );
  L.push('');

  // ── findings ────────────────────────────────────────────────
  if (findings.length === 0) {
    L.push(`  ${green('✓')} No problems found`);
    L.push('');
    return L.join('\n');
  }

  const crit = findings.filter(f => f.severity === 'critical').length;
  L.push(`${yellow('⚠')} ${findings.length} finding${findings.length > 1 ? 's' : ''}${crit ? ` (${crit} critical)` : ''}`);
  L.push('');

  for (const f of findings) {
    const tag = f.severity === 'critical' ? red('CRIT') : f.severity === 'warning' ? yellow('WARN') : dim('INFO');
    const conf = f.confidence === 'certain' ? '' : dim(` [${f.confidence}]`);
    L.push(`  ${tag}  ${f.message}${conf}`);
    for (const e of f.evidence) L.push(dim(`        ${e}`));
    if (f.suggestion) {
      const [first, ...rest] = f.suggestion.split('\n');
      L.push(`        ${dim('→')} ${first}`);
      for (const line of rest) L.push(`        ${line}`);
    }
    L.push('');
  }

  return L.join('\n');
}

/** docker's "37 hours ago" is too wide for a column; squeeze it to "37h". */
function fmtUptime(s: string): string {
  const m = /^(?:About |Less than )?(?:an?|(\d+))\s+(second|minute|hour|day|week|month)/.exec(s);
  if (!m) return s.slice(0, 5);
  const unit: Record<string, string> = { second: 's', minute: 'm', hour: 'h', day: 'd', week: 'w', month: 'mo' };
  return `${m[1] ?? 1}${unit[m[2]]}`;
}

/**
 * CJK characters occupy two terminal columns. Without this, a single worktree
 * named in Chinese or Japanese skews the whole table. Truncates when too wide.
 *
 * Worktree names are data, not UI copy — they are passed through verbatim, so
 * this cannot be deleted just because the interface is in English.
 */
function pad(s: string, width: number): string {
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '');
  const wide = (ch: string) => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch);
  const widthOf = (t: string) => [...t].reduce((a, ch) => a + (wide(ch) ? 2 : 1), 0);

  // Never truncate a string carrying color codes — that would cut an escape
  // sequence in half. Pad only.
  if (visible !== s) return s + ' '.repeat(Math.max(1, width - widthOf(visible)));

  let w = 0, cut = '';
  for (const ch of visible) {
    const cw = wide(ch) ? 2 : 1;
    if (w + cw > width - 2) { cut += '…'; w += 1; break; }
    cut += ch; w += cw;
  }
  return cut + ' '.repeat(Math.max(1, width - w));
}
