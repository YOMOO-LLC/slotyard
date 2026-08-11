const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

/** @type {any} */
let doctor = null;
/** @type {any} */
let config = null;
/** @type {any} */
let selectedSlot = null;
let pollTimer = null;
let busy = false;
let coldOpen = false;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function basename(p) {
  if (!p) return "—";
  const parts = String(p).split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

function fmtMem(miB) {
  if (miB == null) return "—";
  return miB >= 1024 ? `${(miB / 1024).toFixed(2)}G` : `${Math.round(miB)}M`;
}

function fmtUptime(s) {
  if (!s) return "";
  const m = /(?:About |Less than )?(?:an?|(\d+))\s+(second|minute|hour|day|week|month)/i.exec(s);
  if (!m) return String(s).slice(0, 6);
  const unit = { second: "s", minute: "m", hour: "h", day: "d", week: "w", month: "mo" };
  return `${m[1] ?? 1}${unit[m[2].toLowerCase()] || ""}`;
}

const findings = () => doctor?.findings || [];
/** Findings that belong to a slot. unassigned-default is attached to slot 0 but
 *  is not "a problem with slot 0", so it is rendered separately. */
const findingsFor = (slot) =>
  findings().filter((f) => f.slot === slot.slot && f.kind !== "unassigned-default");

function slotDot(slot) {
  const fs = findingsFor(slot);
  if (fs.some((f) => f.severity === "critical")) return "crit";
  if (slot.sleeping?.length || fs.some((f) => f.severity === "warning")) return "warn";
  return slot.running ? "ok" : "cold";
}

function setStatus(msg, isError = false) {
  const n = $("status");
  n.textContent = msg || "";
  n.classList.toggle("error", !!isError);
}

function showMain() {
  $("view-main").classList.remove("hidden");
  $("view-detail").classList.add("hidden");
  selectedSlot = null;
}

function showDetail(slot) {
  selectedSlot = slot;
  $("view-main").classList.add("hidden");
  $("view-detail").classList.remove("hidden");
  renderDetail(slot);
}

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fall back to execCommand if the webview refuses: copying is this panel's
    // only way to act on a finding, so it cannot be allowed to fail.
    const ta = el("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = "Copied";
    btn.classList.add("done");
    setTimeout(() => {
      btn.textContent = old;
      btn.classList.remove("done");
    }, 1400);
  }
}

/** The alert bar. You should know whether anything is wrong without opening the
 *  panel — and the moment you do open it, before reading anything else. */
function renderAlert() {
  const crit = findings().filter((f) => f.severity === "critical").length;
  const warn = findings().filter((f) => f.severity === "warning").length;
  const bar = $("alert");
  if (!crit && !warn) {
    bar.classList.add("hidden");
    return;
  }
  bar.className = `alert ${crit ? "crit" : "warn"}`;
  const n = (v, w) => `${v} ${w}${v === 1 ? "" : "s"}`;
  bar.textContent = crit
    ? `${n(crit, "critical issue")}${warn ? ` · ${n(warn, "warning")}` : ""}`
    : n(warn, "warning");
}

function sectionHeader(text, right) {
  const h = el("div", "sec");
  h.appendChild(el("span", null, text));
  if (right) h.appendChild(el("span", "sec-right", right));
  return h;
}

function slotRow(slot) {
  const claimants = slot.claimants || [];
  const name =
    claimants.length === 0
      ? "unclaimed"
      : claimants.length === 1
        ? basename(claimants[0])
        : `${claimants.length} claimants`;
  const sleep = slot.sleeping || [];

  const row = el("div", "row");
  const top = el("div", "row-top");
  top.appendChild(el("span", `dot ${slotDot(slot)}`));
  top.appendChild(el("span", "slot", `S${slot.slot}`));
  const nameEl = el("span", "name", name);
  if (claimants.length === 1) nameEl.title = claimants[0];
  top.appendChild(nameEl);
  if (slot.running) {
    top.appendChild(el("span", "mem", fmtMem(slot.memMiB)));
    top.appendChild(el("span", "up", fmtUptime(slot.uptime)));
  } else {
    top.appendChild(el("span", "up", slot.volumes?.length ? "volume kept" : "empty"));
  }
  row.appendChild(top);

  if (sleep.length) {
    const sub = el("div", "row-sub");
    sub.appendChild(el("span", "tag-sleep", `💤 ${sleep.join(", ")} asleep`));
    row.appendChild(sub);
    const actions = el("div", "actions");
    const b = el("button", "primary", sleep.length === 1 ? `Wake ${sleep[0]}` : "Wake");
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      lifecycle("wake", slot.slot, sleep.length === 1 ? sleep[0] : null);
    });
    actions.appendChild(b);
    row.appendChild(actions);
  }

  row.addEventListener("click", () => showDetail(slot));
  return row;
}

/** Unallocated worktrees are not "slot 0". They are a pile of projects that
 *  never got a slot, so they get their own shape rather than posing as a row. */
function unassignedRow(f) {
  const row = el("div", "row unassigned");
  const top = el("div", "row-top");
  top.appendChild(el("span", "dot crit"));
  top.appendChild(el("span", "name", f.message || "worktrees on the unallocated default project_id"));
  row.appendChild(top);
  row.appendChild(el("div", "row-sub mono", `project_id = ${(f.evidence || [])[0] || ""}`.replace("project_id = project_id = ", "project_id = ")));
  const actions = el("div", "actions");
  const b = el("button", null, "Copy fix commands");
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    copy(f.suggestion || "", b);
  });
  actions.appendChild(b);
  row.appendChild(actions);
  return row;
}

function renderList() {
  const list = $("list");
  list.innerHTML = "";
  if (!doctor) {
    list.appendChild(el("div", "empty", "Scanning…"));
    return;
  }

  const slots = doctor.slots || [];
  const running = slots.filter((s) => s.running).sort((a, b) => a.slot - b.slot);
  const cold = slots.filter((s) => !s.running && s.slot !== 0).sort((a, b) => a.slot - b.slot);
  const totalMem = running.reduce((a, x) => a + (x.memMiB || 0), 0);

  list.appendChild(sectionHeader(`RUNNING ${running.length}`, totalMem ? fmtMem(totalMem) : ""));
  if (!running.length) list.appendChild(el("div", "empty", "No environments running"));
  for (const s of running) list.appendChild(slotRow(s));

  const unassigned = findings().find((f) => f.kind === "unassigned-default");
  if (unassigned) list.appendChild(unassignedRow(unassigned));

  if (cold.length) {
    const head = sectionHeader(`${coldOpen ? "▾" : "▸"} STOPPED ${cold.length}`, "");
    head.className = "sec toggle";
    head.addEventListener("click", () => {
      coldOpen = !coldOpen;
      renderList();
    });
    list.appendChild(head);
    if (coldOpen) for (const s of cold) list.appendChild(slotRow(s));
  }
}

function renderFindings() {
  const box = $("findings");
  box.innerHTML = "";
  // unassigned already appears in the list in its own shape; do not repeat it
  const fs = findings().filter((f) => f.kind !== "unassigned-default");
  if (!fs.length) {
    box.appendChild(sectionHeader("FINDINGS", ""));
    box.appendChild(el("div", "empty", "✓ No problems found"));
    return;
  }
  box.appendChild(sectionHeader(`FINDINGS ${fs.length}`, ""));
  for (const f of fs) {
    const sev = f.severity === "critical" ? "crit" : f.severity === "warning" ? "warn" : "info";
    const label = f.severity === "critical" ? "CRIT" : f.severity === "warning" ? "WARN" : "INFO";
    const row = el("div", "frow");

    const head = el("div", "frow-head");
    head.appendChild(el("span", `sev ${sev}`, label));
    head.appendChild(el("span", "msg", f.message || f.kind));
    if (f.confidence && f.confidence !== "certain") {
      head.appendChild(el("span", "conf", f.confidence));
    }
    row.appendChild(head);

    const ev = (f.evidence || []).slice(0, 2).join(" · ");
    if (ev) row.appendChild(el("div", "ev", ev));

    if (f.suggestion) {
      const sug = el("div", "sug");
      sug.appendChild(el("code", null, f.suggestion.split("\n")[0]));
      const b = el("button", "copy", "Copy");
      b.addEventListener("click", () => copy(f.suggestion, b));
      sug.appendChild(b);
      row.appendChild(sug);
    }
    box.appendChild(row);
  }
}

function renderDetail(slot) {
  $("d-slot").textContent = `SLOT ${slot.slot}`;
  const claimants = slot.claimants || [];
  const name = claimants.length === 1 ? basename(claimants[0]) : slot.projectId || `slot ${slot.slot}`;
  $("d-name").textContent = "";
  $("d-title").textContent = name;

  const state = slot.sleeping?.length
    ? "partially asleep"
    : slot.running
      ? "running"
      : slot.volumes?.length
        ? "stopped (volume kept)"
        : "empty";
  $("d-meta").textContent = [
    slot.projectId,
    state,
    slot.running ? fmtMem(slot.memMiB) : null,
    slot.running ? fmtUptime(slot.uptime) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  $("d-path").textContent = claimants.length === 1 ? claimants[0] : claimants.join("\n");

  const ports = $("d-ports");
  ports.innerHTML = "";
  // Ports always come from what the CLI computed. The formula is a per-project
  // convention, and a UI that applies it itself produces wrong links elsewhere.
  const P = slot.ports || {};
  const openable = { web: "web", api: "api", studio: "studio", inbucket: "mail" };
  for (const [role, label] of Object.entries(openable)) {
    if (P[role] == null) continue;
    const b = el("button", null, `${label} :${P[role]}`);
    b.addEventListener("click", () => invoke("open_url", { url: `http://127.0.0.1:${P[role]}` }));
    ports.appendChild(b);
  }
  if (P.db != null) {
    const b = el("button", "flat", `db :${P.db}`);
    b.title = "Click to copy the connection string";
    b.addEventListener("click", () =>
      copy(`postgresql://postgres:postgres@127.0.0.1:${P.db}/postgres`, b),
    );
    ports.appendChild(b);
  }

  const tbody = $("d-roles");
  tbody.innerHTML = "";
  const containers = slot.containers || [];
  if (!containers.length) {
    const tr = el("tr");
    const td = el("td", "role", "No containers");
    td.colSpan = 3;
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    const STATE = { running: "running", exited: "stopped", created: "not started", paused: "paused" };
    for (const c of containers) {
      const role = c.role || "?";
      const st = c.state || "?";
      const tr = el("tr");
      tr.appendChild(el("td", "role", role));
      tr.appendChild(el("td", st === "running" ? "run" : "ex", STATE[st] || st));
      const act = el("td");
      if (st !== "running" && role !== "?") {
        const b = el("button", "mini", "Wake");
        b.addEventListener("click", () => lifecycle("wake", slot.slot, role));
        act.appendChild(b);
      }
      tr.appendChild(act);
      tbody.appendChild(tr);
    }
  }

  $("d-wake").onclick = () => lifecycle("wake", slot.slot, null);
  $("d-sleep").onclick = () => lifecycle("sleep", slot.slot, null);
}

async function lifecycle(action, slot, role) {
  setStatus(`${action === "wake" ? "Waking" : "Sleeping"} S${slot}${role ? ` ${role}` : ""}…`);
  try {
    const out = await invoke("run_lifecycle", { action, slot, role: role || null, dryRun: false });
    setStatus(String(out).split("\n").filter(Boolean).slice(0, 2).join(" · "));
    await refresh({ full: true });
    if (selectedSlot) {
      const updated = (doctor?.slots || []).find((s) => s.slot === selectedSlot.slot);
      if (updated) showDetail(updated);
    }
  } catch (e) {
    setStatus(String(e), true);
  }
}

/**
 * @param {{ quiet?: boolean, full?: boolean }} [opts]
 * quiet: background poll, no "Scanning…" flicker
 * full:  skip --fast, so docker stats, identity and ports are included.
 *        Manual refresh only.
 */
async function refresh(opts = {}) {
  if (busy) return;
  busy = true;
  const { quiet = false, full = false } = opts;
  if (!quiet) setStatus("Scanning…");
  try {
    config = await invoke("get_config");
    doctor = await invoke("run_doctor", { fast: !full });
    const repoName = doctor.repo ? basename(doctor.repo) : basename(config?.repo);
    $("repo").textContent = repoName || "—";
    $("repo").title = doctor.repo || config?.repo || "";
    renderAlert();
    renderList();
    renderFindings();
    if (selectedSlot) {
      const updated = (doctor?.slots || []).find((s) => s.slot === selectedSlot.slot);
      if (updated) selectedSlot = updated;
    }
    invoke("set_tray_state", {
      critical: findings().filter((f) => f.severity === "critical").length,
      warning: findings().filter((f) => f.severity === "warning").length,
      running: (doctor.slots || []).filter((s) => s.running).length,
    }).catch(() => {});
    setStatus(
      `${full ? "Full scan" : "Updated"} ${new Date().toLocaleTimeString("en-GB", { hour12: false })}`,
    );
  } catch (e) {
    setStatus(String(e), true);
  } finally {
    busy = false;
  }
}

/**
 * Render fast first so the panel has content almost immediately, then follow up
 * with a full scan. Without the second pass the memory column stays empty
 * forever (--fast skips docker stats) and the alert under-reports, because the
 * identity and port checks are skipped too.
 */
async function refreshThenFull() {
  await refresh({ quiet: true, full: false });
  await refresh({ full: true });
}

function startPoll() {
  stopPoll();
  // 10s quiet fast polls. A 5s full scan with docker stats used to freeze the UI.
  const sec = Math.max(config?.pollSeconds || 10, 8);
  pollTimer = setInterval(() => {
    if (document.visibilityState === "visible") refresh({ quiet: true, full: false });
  }, sec * 1000);
}

function stopPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function chooseRepo() {
  try {
    config = await invoke("pick_repo");
    await refresh();
  } catch (e) {
    if (String(e) !== "cancelled") setStatus(String(e), true);
  }
}

function bind() {
  $("btn-refresh").addEventListener("click", () => refresh({ full: true }));
  $("btn-repo").addEventListener("click", () => chooseRepo());
  $("btn-back").addEventListener("click", () => showMain());
  $("alert").addEventListener("click", () => {
    showMain();
    $("findings").scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  bind();
  try {
    config = await invoke("get_config");
  } catch {
    /* ignore */
  }
  await refreshThenFull();
  startPoll();

  listen("panel-opened", () => {
    refreshThenFull();
    startPoll();
  });
  listen("force-refresh", () => refresh({ full: true }));
});
