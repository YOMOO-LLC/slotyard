const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

/** @type {any[]} — one report per monitored repo, in config order */
let reports = [];
/** @type {any} */
let config = null;
/** @type {any} */
let selectedSlot = null;
let pollTimer = null;
let busy = false;
/** Per repo, so folding one does not fold the others */
let coldOpen = {};
let settingsOpen = false;
let version = null;
let launchStatus = null;
let cliResolution = null;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const POLL_FLOOR = 8;

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

/** Findings across every monitored repo, each tagged with where it came from.
 *  A finding in the second repo has to reach the badge too — otherwise the icon
 *  quietly means "the first repo is fine", which is the exact blind spot this
 *  tool exists to remove. */
const findings = () =>
  reports.flatMap((r) => (r.findings || []).map((f) => ({ ...f, _repo: r.repo })));
const okReports = () => reports.filter((r) => r.ok !== false);
const failedReports = () => reports.filter((r) => r.ok === false);
const multiRepo = () => (config?.repos || []).length > 1;
/** Every slot across every repo, tagged with its owner so two repos can both
 *  have a "slot 4" without the panel confusing them. */
const allSlots = () =>
  okReports().flatMap((r) => (r.slots || []).map((s) => ({ ...s, _repo: r.repo })));

function renderRepoLabel() {
  const repos = config?.repos || [];
  const label = $("repo");
  if (repos.length === 1) {
    label.textContent = basename(repos[0]);
    label.title = repos[0];
  } else if (repos.length === 0) {
    label.textContent = "—";
    label.title = "";
  } else {
    label.textContent = `${repos.length} repos`;
    label.title = repos.join("\n");
  }
}
const mutedKinds = () => new Set((config?.mutedKinds || []).filter((k) => k !== "critical"));
const visibleFindings = () =>
  findings().filter((f) => f.severity === "critical" || !mutedKinds().has(f.kind));
/** Findings that belong to a slot. unassigned-default is attached to slot 0 but
 *  is not "a problem with slot 0", so it is rendered separately. */
const findingsFor = (slot) =>
  visibleFindings().filter(
    (f) =>
      f.slot === slot.slot &&
      f._repo === slot._repo &&
      f.kind !== "unassigned-default",
  );

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
  settingsOpen = false;
  $("view-main").classList.remove("hidden");
  $("view-detail").classList.add("hidden");
  $("view-settings").classList.add("hidden");
  selectedSlot = null;
}

function showDetail(slot) {
  settingsOpen = false;
  selectedSlot = slot;
  $("view-main").classList.add("hidden");
  $("view-detail").classList.remove("hidden");
  $("view-settings").classList.add("hidden");
  renderDetail(slot);
}

function showSettings() {
  settingsOpen = true;
  selectedSlot = null;
  $("view-main").classList.add("hidden");
  $("view-detail").classList.add("hidden");
  $("view-settings").classList.remove("hidden");
  renderSettings();
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
  const visible = visibleFindings();
  const crit = visible.filter((f) => f.severity === "critical").length;
  const warn = visible.filter((f) => f.severity === "warning").length;
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

function slotRow(slot, repo) {
  slot = { ...slot, _repo: slot._repo ?? repo };
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
      lifecycle("wake", slot.slot, sleep.length === 1 ? sleep[0] : null, slot._repo);
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
  if (!reports.length) {
    list.appendChild(el("div", "empty", config?.pauseScanning ? "Scanning paused" : "Scanning…"));
    return;
  }

  // A repo that could not be scanned gets a visible row rather than vanishing.
  // Silence and health must never look the same.
  for (const r of failedReports()) {
    const row = el("div", "row unassigned");
    const top = el("div", "row-top");
    top.appendChild(el("span", "dot warn"));
    top.appendChild(el("span", "name", basename(r.repo)));
    row.appendChild(top);
    row.appendChild(el("div", "row-sub mono", r.error || "could not be scanned"));
    list.appendChild(row);
  }

  for (const rep of okReports()) {
    if (multiRepo()) {
      const h = sectionHeader(basename(rep.repo).toUpperCase(), rep.layout || "");
      h.className = "sec repo-head";
      h.title = rep.repo;
      list.appendChild(h);
    }
    renderRepoSlots(list, rep);
  }
}

/** One repo's slots. Identical output to the single-repo layout, so nothing
 *  changes visually for the common case of watching exactly one. */
function renderRepoSlots(list, rep) {
  const slots = rep.slots || [];
  const running = slots.filter((s) => s.running).sort((a, b) => a.slot - b.slot);
  const cold = slots.filter((s) => !s.running && s.slot !== 0).sort((a, b) => a.slot - b.slot);
  const totalMem = running.reduce((a, x) => a + (x.memMiB || 0), 0);

  list.appendChild(sectionHeader(`RUNNING ${running.length}`, totalMem ? fmtMem(totalMem) : ""));
  if (!running.length) list.appendChild(el("div", "empty", "No environments running"));
  for (const s of running) list.appendChild(slotRow(s, rep.repo));

  const unassigned = visibleFindings().find(
    (f) => f.kind === "unassigned-default" && f._repo === rep.repo,
  );
  if (unassigned) list.appendChild(unassignedRow(unassigned));

  if (cold.length) {
    const key = rep.repo;
    const open = coldOpen[key] ?? false;
    const head = sectionHeader(`${open ? "▾" : "▸"} STOPPED ${cold.length}`, "");
    head.className = "sec toggle";
    head.addEventListener("click", () => {
      coldOpen[key] = !open;
      renderList();
    });
    list.appendChild(head);
    if (open) for (const s of cold) list.appendChild(slotRow(s, rep.repo));
  }
}

function renderFindings() {
  const box = $("findings");
  box.innerHTML = "";
  if (!reports.length) {
    box.appendChild(sectionHeader("FINDINGS", ""));
    box.appendChild(el("div", "empty", config?.pauseScanning ? "No current scan" : "Scanning…"));
    return;
  }
  // unassigned already appears in the list in its own shape; do not repeat it
  const fs = visibleFindings().filter((f) => f.kind !== "unassigned-default");

  // A mute hides a row; it must never quietly change what is true. Without this
  // the panel reads "FINDINGS 3" when the scan actually returned 4, and a tool
  // whose whole proposition is telling the truth has started lying by omission.
  const hidden = findings().length - visibleFindings().length;
  const mutedNote = hidden ? `${hidden} muted` : "";

  if (!fs.length) {
    box.appendChild(sectionHeader("FINDINGS", mutedNote));
    box.appendChild(el("div", "empty", hidden ? "✓ Nothing unmuted to report" : "✓ No problems found"));
    return;
  }
  box.appendChild(sectionHeader(`FINDINGS ${fs.length}`, mutedNote));
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
        b.addEventListener("click", () => lifecycle("wake", slot.slot, role, slot._repo));
        act.appendChild(b);
      }
      tr.appendChild(act);
      tbody.appendChild(tr);
    }
  }

  $("d-wake").onclick = () => lifecycle("wake", slot.slot, null, slot._repo);
  $("d-sleep").onclick = () => lifecycle("sleep", slot.slot, null, slot._repo);
}

async function lifecycle(action, slot, role, repo) {
  setStatus(`${action === "wake" ? "Waking" : "Sleeping"} S${slot}${role ? ` ${role}` : ""}…`);
  try {
    const out = await invoke("run_lifecycle", {
      action, slot, role: role || null, dryRun: false, repo: repo || null,
    });
    setStatus(String(out).split("\n").filter(Boolean).slice(0, 2).join(" · "));
    await refresh({ full: true });
    if (selectedSlot) {
      const updated = allSlots().find(
        (s) => s.slot === selectedSlot.slot && s._repo === selectedSlot._repo,
      );
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
    if (config.pauseScanning) {
      stopPoll();
      reports = [];
      renderRepoLabel();
      renderAlert();
      renderList();
      renderFindings();
      setStatus("Scanning paused");
      if (settingsOpen) renderSettings();
      return;
    }
    reports = await invoke("run_doctor", { fast: !full });
    renderRepoLabel();
    renderAlert();
    renderList();
    renderFindings();
    if (settingsOpen) renderSettings();
    if (selectedSlot) {
      const updated = allSlots().find(
        (s) => s.slot === selectedSlot.slot && s._repo === selectedSlot._repo,
      );
      if (updated) selectedSlot = updated;
    }
    updateTrayFromVisible();
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
  if (config?.pauseScanning) return;
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

function updateTrayFromVisible() {
  const visible = visibleFindings();
  invoke("set_tray_state", {
    critical: visible.filter((f) => f.severity === "critical").length,
    warning: visible.filter((f) => f.severity === "warning").length,
    running: allSlots().filter((s) => s.running).length,
  }).catch(() => {});
}

function renderRepoSettings() {
  $("settings-layout").textContent = okReports().map((r) => r.layout).join(" · ") || "—";

  // The monitored set, not a single active repo. Every one of these raises the
  // badge; a repo you removed stops being watched, which is the whole point of
  // showing the list rather than hiding it behind a picker.
  const box = $("recent-repos");
  box.innerHTML = "";
  const repos = config?.repos || [];
  if (!repos.length) {
    box.appendChild(el("div", "setting-note", "No repos monitored. Add one to start."));
    return;
  }
  for (const repo of repos) {
    const row = el("div", "repo-row");
    const label = el("span", "repo-path", repo);
    label.title = repo;
    row.appendChild(label);
    const rm = el("button", "mini", "Remove");
    rm.addEventListener("click", async () => {
      try {
        config = await invoke("remove_repo", { repo });
        await refresh({ full: true });
      } catch (e) {
        setStatus(String(e), true);
      }
    });
    row.appendChild(rm);
    box.appendChild(row);
  }
}

function renderLaunchSettings() {
  const input = $("launch-login");
  const note = $("launch-note");
  note.classList.remove("error");
  if (!launchStatus) {
    input.disabled = true;
    input.checked = false;
    note.textContent = "";
    return;
  }
  input.checked = launchStatus.enabled;
  input.disabled = !launchStatus.canEnable;
  note.textContent = launchStatus.canEnable
    ? launchStatus.enabled
      ? "Runs at login."
      : ""
    : `Requires slotyard.app in /Applications (currently ${launchStatus.path}).`;
}

function renderPollSettings() {
  const stored = Number.isFinite(config?.pollSeconds) ? config.pollSeconds : 10;
  const effective = Math.max(stored, POLL_FLOOR);
  $("poll-seconds").value = effective;
  $("poll-note").textContent =
    stored !== effective
      ? `Stored ${stored}s is below the ${POLL_FLOOR}s floor; effective is ${effective}s.`
      : "";
}

function renderBadgeSettings() {
  const mode = config?.badgeMode || "critical_and_warning";
  for (const b of document.querySelectorAll(".badge-option")) {
    b.classList.toggle("active", b.dataset.mode === mode);
  }
}

function renderMuteSettings() {
  const box = $("mute-list");
  box.innerHTML = "";
  const byKind = new Map();
  for (const f of findings()) {
    if (f.severity === "critical") continue;
    if (!byKind.has(f.kind)) byKind.set(f.kind, f.message || f.kind);
  }
  if (!byKind.size) {
    box.appendChild(el("div", "setting-note", "No warning or info findings in the current scan."));
  } else {
    for (const [kind, message] of byKind) {
      const muted = mutedKinds().has(kind);
      const label = el("label", "mute-row");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = muted;
      cb.addEventListener("change", async () => {
        try {
          config = await invoke("set_muted_kind", { kind, muted: cb.checked });
          renderMuteSettings();
          renderAlert();
          renderList();
          renderFindings();
          updateTrayFromVisible();
        } catch (e) {
          cb.checked = !cb.checked;
          setStatus(String(e), true);
        }
      });
      const body = el("div", "setting-main");
      body.appendChild(el("span", "mute-kind", kind));
      if (message) body.appendChild(el("div", "mute-message", message));
      label.appendChild(cb);
      label.appendChild(body);
      box.appendChild(label);
    }
  }
  const hiddenCount = findings().filter(
    (f) => f.severity !== "critical" && mutedKinds().has(f.kind),
  ).length;
  if (hiddenCount) {
    box.appendChild(
      el("div", "setting-note", `${hiddenCount} finding${hiddenCount === 1 ? "" : "s"} hidden by mutes.`),
    );
  }
}

function renderCliSettings() {
  $("settings-cli").textContent = config?.cli || "—";
  const resolved = $("settings-cli-resolved");
  const source = $("settings-cli-source");
  source.classList.remove("error");
  if (!cliResolution) {
    resolved.textContent = "Checking…";
    source.textContent = "";
    return;
  }
  if (cliResolution.error) {
    resolved.textContent = "Not found";
    source.classList.add("error");
    source.textContent = cliResolution.error;
    return;
  }
  resolved.textContent = cliResolution.path || "—";
  const label = { config: "Configured path", build: "Repo build path", path: "PATH" }[
    cliResolution.source
  ] || cliResolution.source;
  source.textContent = `${label}${cliResolution.note ? ` · ${cliResolution.note}` : ""}`;
}

async function loadSettingsInfo() {
  try {
    launchStatus = await invoke("get_launch_status");
  } catch (e) {
    launchStatus = { enabled: false, canEnable: false, path: "" };
    $("launch-note").textContent = String(e);
  }
  renderLaunchSettings();
  try {
    cliResolution = await invoke("get_cli_resolution");
  } catch (e) {
    cliResolution = { path: null, source: "", note: null, error: String(e) };
  }
  renderCliSettings();
}

function renderSettings() {
  renderRepoSettings();
  renderLaunchSettings();
  renderPollSettings();
  $("pause-scanning").checked = !!config?.pauseScanning;
  renderBadgeSettings();
  renderMuteSettings();
  renderCliSettings();
  $("settings-version").textContent = version ? `v${version}` : "";
  if (!launchStatus || !cliResolution) loadSettingsInfo();
}

async function chooseRepo() {
  try {
    config = await invoke("pick_repo");
    await refresh({ full: true });
  } catch (e) {
    if (String(e) !== "cancelled") setStatus(String(e), true);
  }
}

function bind() {
  $("btn-refresh").addEventListener("click", () => refresh({ full: true }));
  $("btn-repo").addEventListener("click", () => showSettings());
  $("btn-back").addEventListener("click", () => showMain());
  $("btn-settings-back").addEventListener("click", () => showMain());
  $("alert").addEventListener("click", () => {
    showMain();
    $("findings").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("btn-change-repo").addEventListener("click", () => chooseRepo());

  $("launch-login").addEventListener("change", async (e) => {
    const enabled = e.target.checked;
    try {
      launchStatus = await invoke("set_launch_at_login", { enabled });
      renderLaunchSettings();
    } catch (err) {
      e.target.checked = !enabled;
      $("launch-note").classList.add("error");
      $("launch-note").textContent = String(err);
      setStatus(String(err), true);
    }
  });

  $("poll-seconds").addEventListener("change", async () => {
    const seconds = Number($("poll-seconds").value);
    if (!Number.isInteger(seconds) || seconds < 1) {
      setStatus("Poll interval must be at least 1 second.", true);
      renderPollSettings();
      return;
    }
    try {
      config = await invoke("set_poll_seconds", { seconds });
      renderPollSettings();
      startPoll();
    } catch (e) {
      setStatus(String(e), true);
      renderPollSettings();
    }
  });

  $("pause-scanning").addEventListener("change", async (e) => {
    const paused = e.target.checked;
    try {
      config = await invoke("set_pause_scanning", { paused });
      if (paused) {
        reports = [];
        stopPoll();
        setStatus("Scanning paused");
        renderAlert();
        renderList();
        renderFindings();
      } else {
        await refresh({ full: true });
      }
      renderSettings();
    } catch (err) {
      e.target.checked = !paused;
      setStatus(String(err), true);
    }
  });

  for (const b of document.querySelectorAll(".badge-option")) {
    b.addEventListener("click", async () => {
      const mode = b.dataset.mode;
      if (mode === config?.badgeMode) return;
      try {
        config = await invoke("set_badge_mode", { mode });
        renderBadgeSettings();
        updateTrayFromVisible();
      } catch (e) {
        setStatus(String(e), true);
      }
    });
  }

  $("btn-change-cli").addEventListener("click", async () => {
    try {
      config = await invoke("pick_cli");
      cliResolution = null;
      renderSettings();
    } catch (e) {
      if (String(e) !== "cancelled") setStatus(String(e), true);
    }
  });
  $("btn-clear-cli").addEventListener("click", async () => {
    try {
      config = await invoke("clear_cli");
      cliResolution = null;
      renderSettings();
    } catch (e) {
      setStatus(String(e), true);
    }
  });
  $("btn-open-config").addEventListener("click", async () => {
    try {
      await invoke("open_config_file");
      setStatus("Config revealed in Finder.");
    } catch (e) {
      setStatus(String(e), true);
    }
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  bind();
  try {
    config = await invoke("get_config");
    version = await invoke("get_version");
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
