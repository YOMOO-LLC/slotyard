use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, WindowEvent,
};

const PANEL: &str = "panel";
const CONFIG_NAME: &str = "slotyard-desktop.json";
const LAUNCH_AGENT_LABEL: &str = "dev.slotyard.desktop";
const LAUNCH_AGENT_FILE: &str = "dev.slotyard.desktop.plist";
const RECENT_REPO_LIMIT: usize = 5;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
enum BadgeMode {
    #[default]
    #[serde(rename = "critical_and_warning")]
    CriticalAndWarning,
    #[serde(rename = "critical")]
    CriticalOnly,
    #[serde(rename = "never")]
    Never,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    /// Legacy single-repo field. Only read, to migrate an older config once.
    /// `repos` is the truth; see `load_config`.
    repo: Option<String>,
    /// Every repo being monitored. A finding in any of them raises the badge —
    /// a tool whose whole claim is "you cannot see what is silently wrong" must
    /// not have a blind spot of exactly that shape.
    #[serde(default)]
    repos: Vec<String>,
    /// Override path to cli.ts or slotyard binary
    cli: Option<String>,
    /// Poll interval while panel is open (seconds)
    poll_seconds: Option<u64>,
    /// Last few repos picked from the panel, newest first
    #[serde(default)]
    recent_repos: Vec<String>,
    /// No background badge scan and no panel poll while true
    #[serde(default)]
    pause_scanning: bool,
    /// What colours the tray icon may use. Default matches current behaviour.
    #[serde(default)]
    badge_mode: BadgeMode,
    /// Warning/info finding kinds the user muted. Critical is filtered below,
    /// because the product invariant cannot be turned off by a config value.
    #[serde(default)]
    muted_kinds: Vec<String>,
}

struct State {
    config: Mutex<AppConfig>,
    tray: Mutex<TrayCounts>,
}

#[derive(Debug, Clone, Copy, Default)]
struct TrayCounts {
    critical: u32,
    warning: u32,
    running: u32,
}

fn config_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("slotyard")
        .join(CONFIG_NAME)
}

fn load_config() -> AppConfig {
    let path = config_path();
    if let Ok(raw) = std::fs::read_to_string(&path) {
        if let Ok(c) = serde_json::from_str(&raw) {
            let mut cfg: AppConfig = c;
            clean_muted_kinds(&mut cfg);
            migrate_repos(&mut cfg);
            return cfg;
        }
    }
    AppConfig {
        repos: default_repo_guess().into_iter().collect(),
        poll_seconds: Some(5),
        ..Default::default()
    }
}

/// An older config carries a single `repo`. Fold it into `repos` once, then stop
/// writing it, so there is never a moment with two sources of truth.
fn migrate_repos(cfg: &mut AppConfig) {
    if let Some(repo) = cfg.repo.take() {
        if !cfg.repos.iter().any(|r| r == &repo) {
            cfg.repos.insert(0, repo);
        }
    }
    cfg.repos.dedup();
}

fn save_config(cfg: &AppConfig) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(path, raw).map_err(|e| e.to_string())
}

fn clean_muted_kinds(cfg: &mut AppConfig) {
    // "critical" is not a finding kind, but a stale config might contain it.
    // Drop it instead of trying to interpret it: critical findings never mute.
    cfg.muted_kinds.retain(|k| k != "critical");
}

fn remember_repo(repo: &str, recent: &mut Vec<String>) {
    recent.retain(|p| p != repo);
    recent.insert(0, repo.to_string());
    recent.truncate(RECENT_REPO_LIMIT);
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CliResolution {
    path: Option<String>,
    source: String,
    note: Option<String>,
    error: Option<String>,
}

fn default_repo_guess() -> Option<String> {
    let home = dirs::home_dir()?;
    let candidates = [
        home.join("Documents/GitHub/slotyard"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
    ];
    for c in candidates {
        if c.is_dir() {
            if let Ok(p) = c.canonicalize() {
                return Some(p.display().to_string());
            }
        }
    }
    None
}

/// The configured path is a user override, not a wall: if it stops existing,
/// the app must keep working through the same build/PATH fallbacks and say so
/// in Settings. Treating it as a hard error was how a moved repo became an
/// invisible CLI mystery.
fn resolve_cli_detailed(cfg: &AppConfig) -> Result<(PathBuf, String, Option<String>), String> {
    let mut missing_override = None;
    if let Some(ref p) = cfg.cli {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Ok((pb, "config".into(), None));
        }
        missing_override = Some(format!("Configured CLI path missing: {p}"));
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let monorepo_cli = manifest.join("../../src/cli.ts");
    if monorepo_cli.exists() {
        let p = monorepo_cli.canonicalize().map_err(|e| e.to_string())?;
        return Ok((p, "build".into(), missing_override));
    }
    // Same trap as spawning node: a GUI process has launchd's stripped PATH, so
    // `which` would miss a CLI installed under homebrew or ~/.local/bin. This
    // fallback is what keeps the app working when the repo it was built from
    // moves or is removed.
    if let Some(p) = find_on_user_path() {
        return Ok((p, "path".into(), missing_override));
    }
    if let Some(note) = missing_override {
        Err(format!(
            "{note}. Cannot find slotyard CLI. Keep monorepo layout or set cli path."
        ))
    } else {
        Err("Cannot find slotyard CLI. Keep monorepo layout or set cli path.".into())
    }
}

fn resolve_cli(cfg: &AppConfig) -> Result<PathBuf, String> {
    Ok(resolve_cli_detailed(cfg)?.0)
}

fn find_on_user_path() -> Option<PathBuf> {
    let out = Command::new("/usr/bin/which")
        .arg("slotyard")
        .env("PATH", user_path())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(PathBuf::from(s))
    }
}

/// A GUI app launched from Finder or a login item does not inherit the shell's
/// PATH. launchd gives it /usr/bin:/bin:/usr/sbin:/sbin, and neither node nor
/// docker lives there. Without this, the app fails to spawn the CLI the moment
/// it is installed into /Applications — while working perfectly under `npm run
/// dev`, which inherits the terminal's PATH.
fn user_path() -> String {
    let home = dirs::home_dir().unwrap_or_default();
    let mut parts: Vec<String> = [
        home.join(".local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        home.join(".orbstack/bin"), // OrbStack ships docker here
    ]
    .iter()
    .filter(|p| p.is_dir())
    .map(|p| p.display().to_string())
    .collect();
    parts.push(std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".into()));
    parts.join(":")
}

/// node needs an absolute path for the same reason. Version managers (nvm, fnm,
/// volta) install it outside any fixed location, so fall back to asking a login
/// shell once.
fn resolve_node() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    for c in [
        home.join(".local/bin/node"),
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
    ] {
        if c.is_file() {
            return c;
        }
    }
    if let Ok(out) = Command::new("/bin/zsh")
        .args(["-lc", "command -v node"])
        .output()
    {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !s.is_empty() {
            return PathBuf::from(s);
        }
    }
    PathBuf::from("node")
}

fn run_node_cli(cli: &Path, cwd: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = if cli.extension().and_then(|s| s.to_str()) == Some("ts") {
        let mut c = Command::new(resolve_node());
        c.arg("--experimental-strip-types").arg(cli);
        c
    } else {
        Command::new(cli)
    };
    cmd.args(args).current_dir(cwd).env("PATH", user_path());
    let output = cmd
        .output()
        .map_err(|e| format!("failed to spawn CLI: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if stdout.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "CLI produced no stdout (status {:?}): {stderr}",
            output.status.code()
        ));
    }
    Ok(stdout)
}

#[tauri::command]
fn get_config(state: tauri::State<'_, State>) -> AppConfig {
    state.config.lock().unwrap().clone()
}

#[tauri::command]
fn add_repo(state: tauri::State<'_, State>, repo: String) -> Result<AppConfig, String> {
    let path = PathBuf::from(&repo);
    if !path.is_dir() {
        return Err(format!("Not a directory: {repo}"));
    }
    let canonical = path
        .canonicalize()
        .map_err(|e| e.to_string())?
        .display()
        .to_string();
    let mut cfg = state.config.lock().unwrap();
    if !cfg.repos.iter().any(|r| r == &canonical) {
        cfg.repos.push(canonical.clone());
    }
    remember_repo(&canonical, &mut cfg.recent_repos);
    save_config(&cfg)?;
    Ok(cfg.clone())
}

#[tauri::command]
fn remove_repo(state: tauri::State<'_, State>, repo: String) -> Result<AppConfig, String> {
    let mut cfg = state.config.lock().unwrap();
    cfg.repos.retain(|r| r != &repo);
    save_config(&cfg)?;
    Ok(cfg.clone())
}

#[tauri::command]
fn pick_repo(state: tauri::State<'_, State>) -> Result<AppConfig, String> {
    let folder = rfd::FileDialog::new()
        .set_title("Select a repo to monitor")
        .pick_folder()
        .ok_or_else(|| "cancelled".to_string())?;
    add_repo(state, folder.display().to_string())
}

#[tauri::command]
fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn set_poll_seconds(state: tauri::State<'_, State>, seconds: u64) -> Result<AppConfig, String> {
    if seconds == 0 {
        return Err("Poll interval must be at least 1 second.".into());
    }
    let mut cfg = state.config.lock().unwrap();
    cfg.poll_seconds = Some(seconds);
    save_config(&cfg)?;
    Ok(cfg.clone())
}

#[tauri::command]
fn set_pause_scanning(
    state: tauri::State<'_, State>,
    app: AppHandle,
    paused: bool,
) -> Result<AppConfig, String> {
    let mut cfg = state.config.lock().unwrap();
    cfg.pause_scanning = paused;
    save_config(&cfg)?;
    let counts = state.tray.lock().unwrap().clone();
    apply_tray_state(&app, counts, cfg.badge_mode, paused)?;
    Ok(cfg.clone())
}

#[tauri::command]
fn set_badge_mode(
    state: tauri::State<'_, State>,
    app: AppHandle,
    mode: String,
) -> Result<AppConfig, String> {
    let badge = match mode.as_str() {
        "critical_and_warning" => BadgeMode::CriticalAndWarning,
        "critical" => BadgeMode::CriticalOnly,
        "never" => BadgeMode::Never,
        _ => return Err(format!("Unknown badge mode: {mode}")),
    };
    let mut cfg = state.config.lock().unwrap();
    cfg.badge_mode = badge;
    save_config(&cfg)?;
    let counts = state.tray.lock().unwrap().clone();
    apply_tray_state(&app, counts, cfg.badge_mode, cfg.pause_scanning)?;
    Ok(cfg.clone())
}

#[tauri::command]
fn set_muted_kind(
    state: tauri::State<'_, State>,
    kind: String,
    muted: bool,
) -> Result<AppConfig, String> {
    if kind == "critical" {
        return Err("Critical findings cannot be muted.".into());
    }
    let mut cfg = state.config.lock().unwrap();
    if muted {
        if !cfg.muted_kinds.contains(&kind) {
            cfg.muted_kinds.push(kind);
        }
    } else {
        cfg.muted_kinds.retain(|k| k != &kind);
    }
    save_config(&cfg)?;
    Ok(cfg.clone())
}

#[tauri::command]
fn set_cli(state: tauri::State<'_, State>, cli: String) -> Result<AppConfig, String> {
    if cli.trim().is_empty() {
        return Err("CLI path cannot be empty.".into());
    }
    let mut cfg = state.config.lock().unwrap();
    cfg.cli = Some(cli);
    save_config(&cfg)?;
    Ok(cfg.clone())
}

#[tauri::command]
fn clear_cli(state: tauri::State<'_, State>) -> Result<AppConfig, String> {
    let mut cfg = state.config.lock().unwrap();
    cfg.cli = None;
    save_config(&cfg)?;
    Ok(cfg.clone())
}

#[tauri::command]
fn pick_cli(state: tauri::State<'_, State>) -> Result<AppConfig, String> {
    let file = rfd::FileDialog::new()
        .set_title("Select slotyard CLI")
        .pick_file()
        .ok_or_else(|| "cancelled".to_string())?;
    set_cli(state, file.display().to_string())
}

#[tauri::command]
async fn get_cli_resolution(state: tauri::State<'_, State>) -> Result<CliResolution, String> {
    let cfg = state.config.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || match resolve_cli_detailed(&cfg) {
        Ok((path, source, note)) => CliResolution {
            path: Some(path.display().to_string()),
            source,
            note,
            error: None,
        },
        Err(error) => CliResolution {
            path: None,
            source: String::new(),
            note: None,
            error: Some(error),
        },
    })
    .await
    .map_err(|e| format!("join error: {e}"))
}

fn launch_agent_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Library/LaunchAgents")
        .join(LAUNCH_AGENT_FILE)
}

fn running_from_applications() -> bool {
    std::env::current_exe()
        .map(|p| p.display().to_string().starts_with("/Applications/"))
        .unwrap_or(false)
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchStatus {
    enabled: bool,
    can_enable: bool,
    path: String,
}

fn launch_status() -> LaunchStatus {
    LaunchStatus {
        enabled: launch_agent_path().exists(),
        can_enable: running_from_applications(),
        path: std::env::current_exe()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| "unknown".into()),
    }
}

#[tauri::command]
fn get_launch_status() -> LaunchStatus {
    launch_status()
}

#[tauri::command]
fn set_launch_at_login(enabled: bool) -> Result<LaunchStatus, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let path = exe.display().to_string();
    if enabled && !path.starts_with("/Applications/") {
        return Err("Launch at login requires slotyard.app in /Applications.".into());
    }

    let agent = launch_agent_path();
    if enabled {
        if let Some(parent) = agent.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // Writing the plist is enough for future logins. Avoid bootout while the
        // user is inside this same launchd process; it would kill the toggle.
        let plist = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{path}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
"#,
            label = LAUNCH_AGENT_LABEL,
            path = xml_escape(&path),
        );
        std::fs::write(&agent, plist).map_err(|e| e.to_string())?;
    } else if agent.exists() {
        std::fs::remove_file(&agent).map_err(|e| e.to_string())?;
    }
    Ok(launch_status())
}

#[tauri::command]
fn open_config_file(state: tauri::State<'_, State>) -> Result<(), String> {
    let path = config_path();
    if !path.exists() {
        save_config(&state.config.lock().unwrap())?;
    }
    Command::new("open")
        .arg("-R")
        .arg(path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    // Prefer system open; opener plugin also available from frontend
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(format!("open_url not implemented for this OS: {url}"))
    }
}

/// Heavy CLI work must not run on the UI/main thread — that freezes the panel
/// and looks like constant spinning (especially with docker stats on 100+ containers).
#[tauri::command]
async fn run_doctor(
    state: tauri::State<'_, State>,
    fast: Option<bool>,
) -> Result<Vec<serde_json::Value>, String> {
    let cfg = state.config.lock().unwrap().clone();
    if cfg.pause_scanning {
        return Err("Scanning paused.".into());
    }
    if cfg.repos.is_empty() {
        return Err("No repo selected. Add one in Settings.".into());
    }
    let cli = resolve_cli(&cfg)?;
    let use_fast = fast.unwrap_or(true);

    let mut reports = Vec::new();
    for repo in cfg.repos.iter() {
        // A repo that cannot be scanned still gets a row. Dropping it would be
        // the same blind spot this tool exists to remove: the panel would look
        // healthy because one of the things it watches went quiet.
        let cwd = PathBuf::from(repo);
        if !cwd.is_dir() {
            reports.push(serde_json::json!({
                "repo": repo, "ok": false, "error": format!("Path missing: {repo}")
            }));
            continue;
        }
        let cli = cli.clone();
        let args: Vec<&str> = if use_fast { vec!["--json", "--fast"] } else { vec!["--json"] };
        let out = tauri::async_runtime::spawn_blocking(move || run_node_cli(&cli, &cwd, &args))
            .await
            .map_err(|e| format!("join error: {e}"))?;
        match out {
            Ok(stdout) => match serde_json::from_str::<serde_json::Value>(&stdout) {
                Ok(mut v) => {
                    v["ok"] = serde_json::Value::Bool(true);
                    if v["repo"].is_null() {
                        v["repo"] = serde_json::Value::String(repo.clone());
                    }
                    reports.push(v);
                }
                Err(e) => reports.push(serde_json::json!({
                    "repo": repo, "ok": false, "error": format!("invalid doctor JSON: {e}")
                })),
            },
            Err(e) => reports.push(serde_json::json!({ "repo": repo, "ok": false, "error": e })),
        }
    }
    Ok(reports)
}

/// `repo` says which monitored repo the slot belongs to. With several being
/// watched, the caller has to name it — guessing would wake somebody else's stack.
#[tauri::command]
async fn run_lifecycle(
    state: tauri::State<'_, State>,
    action: String,
    slot: u32,
    role: Option<String>,
    dry_run: Option<bool>,
    repo: Option<String>,
) -> Result<String, String> {
    if action != "wake" && action != "sleep" {
        return Err("action must be wake or sleep".into());
    }
    let cfg = state.config.lock().unwrap().clone();
    let repo = repo
        .or_else(|| cfg.repos.first().cloned())
        .ok_or_else(|| "No repo selected".to_string())?;
    let cwd = PathBuf::from(&repo);
    let cli = resolve_cli(&cfg)?;
    let mut args: Vec<String> = vec![action, slot.to_string()];
    if let Some(r) = role {
        if !r.is_empty() {
            args.push("--role".into());
            args.push(r);
        }
    }
    if dry_run.unwrap_or(false) {
        args.push("--dry-run".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        run_node_cli(&cli, &cwd, &arg_refs)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// The tray icon is this tool's only always-present surface: you have to know
/// whether anything is wrong without opening the panel, or it is just an icon
/// sitting in /Applications.
///
/// Note: template mode forces the icon to the system's monochrome rendering,
/// which erases the coloured dot. It must be off whenever a badge is shown.
fn apply_tray_state(
    app: &AppHandle,
    counts: TrayCounts,
    mode: BadgeMode,
    paused: bool,
) -> Result<(), String> {
    {
        let state: tauri::State<'_, State> = app.state();
        *state.tray.lock().unwrap() = counts;
    }
    let tray = app.tray_by_id("main").ok_or("tray missing")?;
    let (bytes, template): (&[u8], bool) = if paused {
        (include_bytes!("../icons/tray.png"), true)
    } else {
        match mode {
            BadgeMode::Never => (include_bytes!("../icons/tray.png"), true),
            BadgeMode::CriticalOnly => {
                if counts.critical > 0 {
                    (include_bytes!("../icons/tray-critical.png"), false)
                } else {
                    (include_bytes!("../icons/tray.png"), true)
                }
            }
            BadgeMode::CriticalAndWarning => {
                if counts.critical > 0 {
                    (include_bytes!("../icons/tray-critical.png"), false)
                } else if counts.warning > 0 {
                    (include_bytes!("../icons/tray-warning.png"), false)
                } else {
                    (include_bytes!("../icons/tray.png"), true)
                }
            }
        }
    };
    let icon = Image::from_bytes(bytes).map_err(|e| e.to_string())?;
    tray.set_icon(Some(icon)).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    tray.set_icon_as_template(template)
        .map_err(|e| e.to_string())?;
    let tip = if paused {
        "slotyard — paused".to_string()
    } else {
        match (counts.critical, counts.warning) {
            (0, 0) => format!("slotyard — {} running, all clear", counts.running),
            (0, w) => format!("slotyard — {} running, {w} warning", counts.running),
            (c, 0) => format!("slotyard — {c} critical"),
            (c, w) => format!("slotyard — {c} critical, {w} warning"),
        }
    };
    tray.set_tooltip(Some(&tip)).map_err(|e| e.to_string())?;
    Ok(())
}

/// While the panel is open the frontend reports its own counts, saving a scan.
#[tauri::command]
fn set_tray_state(app: AppHandle, critical: u32, warning: u32, running: u32) -> Result<(), String> {
    let state: tauri::State<'_, State> = app.state();
    let cfg = state.config.lock().unwrap().clone();
    apply_tray_state(
        &app,
        TrayCounts {
            critical,
            warning,
            running,
        },
        cfg.badge_mode,
        cfg.pause_scanning,
    )
}

/// The badge cannot depend on the hidden webview. WebKit freezes its timers as
/// soon as the panel closes — and "know without opening it" is the only reason
/// this icon exists. So the scan runs here instead.
///
/// Full doctor every 60s, not `--fast`: `--fast` skips identity (JWT fingerprint)
/// and port probes — the silent-contamination cases the icon exists to surface.
/// Stats are the expensive part; 60s is the budget.
fn spawn_badge_watcher(app: AppHandle, every: u64) {
    std::thread::spawn(move || loop {
        let (cfg, last_counts) = {
            let s: tauri::State<'_, State> = app.state();
            let cfg = s.config.lock().unwrap().clone();
            let last_counts = s.tray.lock().unwrap().clone();
            (cfg, last_counts)
        };
        if cfg.pause_scanning {
            let _ = apply_tray_state(&app, last_counts, cfg.badge_mode, true);
            std::thread::sleep(std::time::Duration::from_secs(every));
            continue;
        }
        // Sum across every monitored repo. A critical in any one of them has to
        // colour the icon, or the badge quietly means "the first repo is fine".
        if let Ok(cli) = resolve_cli(&cfg) {
            let mut total = TrayCounts::default();
            let mut scanned_any = false;
            for repo in cfg.repos.iter() {
                let cwd = PathBuf::from(repo);
                if !cwd.is_dir() {
                    continue;
                }
                if let Ok(out) = run_node_cli(&cli, &cwd, &["--json"]) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&out) {
                        let c = tray_counts_from_doctor(&v, &cfg.muted_kinds);
                        total.critical += c.critical;
                        total.warning += c.warning;
                        total.running += c.running;
                        scanned_any = true;
                    }
                }
            }
            if scanned_any {
                let _ = apply_tray_state(&app, total, cfg.badge_mode, false);
            }
        }
        std::thread::sleep(std::time::Duration::from_secs(every));
    });
}

fn tray_counts_from_doctor(v: &serde_json::Value, muted_kinds: &[String]) -> TrayCounts {
    let mut counts = TrayCounts::default();
    if let Some(findings) = v["findings"].as_array() {
        for f in findings {
            let severity = f["severity"].as_str().unwrap_or("");
            let kind = f["kind"].as_str().unwrap_or("");
            if severity == "critical" {
                counts.critical += 1;
                continue;
            }
            // Muting is per-kind, but only for warning/info severity. A critical
            // collision must still badge even if its kind is muted for warnings.
            if severity == "warning" {
                if muted_kinds.iter().any(|k| k == kind) {
                    continue;
                }
                counts.warning += 1;
            }
        }
    }
    counts.running = v["slots"]
        .as_array()
        .map(|a| a.iter().filter(|s| s["running"] == true).count() as u32)
        .unwrap_or(0);
    counts
}

fn position_panel_near_tray(app: &AppHandle, x: f64, y: f64) {
    if let Some(win) = app.get_webview_window(PANEL) {
        let scale = win.scale_factor().unwrap_or(1.0);
        let w = 380.0 * scale;
        let px = (x - w + 24.0).max(8.0);
        let py = y + 6.0;
        let _ = win.set_position(PhysicalPosition::new(px as i32, py as i32));
    }
}

fn toggle_panel(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(PANEL) {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
            let _ = app.emit("panel-opened", ());
        }
    }
}

fn show_panel_at(app: &AppHandle, x: f64, y: f64) {
    position_panel_near_tray(app, x, y);
    if let Some(win) = app.get_webview_window(PANEL) {
        let _ = win.show();
        let _ = win.set_focus();
        let _ = app.emit("panel-opened", ());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config = load_config();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(State {
            config: Mutex::new(config),
            tray: Mutex::new(TrayCounts::default()),
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            add_repo,
            remove_repo,
            pick_repo,
            get_version,
            set_poll_seconds,
            set_pause_scanning,
            set_badge_mode,
            set_muted_kind,
            set_cli,
            clear_cli,
            pick_cli,
            get_cli_resolution,
            get_launch_status,
            set_launch_at_login,
            open_config_file,
            open_url,
            run_doctor,
            run_lifecycle,
            set_tray_state
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let show_i = MenuItem::with_id(app, "show", "Open panel", true, None::<&str>)?;
            let refresh_i = MenuItem::with_id(app, "refresh", "Refresh now", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit slotyard", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &refresh_i, &quit_i])?;

            let icon = Image::from_bytes(include_bytes!("../icons/tray.png")).expect("tray icon");

            let tray = TrayIconBuilder::with_id("main")
                .icon(icon)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("slotyard")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => toggle_panel(app),
                    "refresh" => {
                        let _ = app.emit("force-refresh", ());
                        if let Some(win) = app.get_webview_window(PANEL) {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        position,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window(PANEL) {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                show_panel_at(app, position.x, position.y);
                            }
                        }
                    }
                })
                .build(app)?;

            #[cfg(target_os = "macos")]
            {
                let _ = tray.set_icon_as_template(true);
            }

            let cfg = app.state::<State>().config.lock().unwrap().clone();
            let _ = apply_tray_state(
                app.handle(),
                TrayCounts::default(),
                cfg.badge_mode,
                cfg.pause_scanning,
            );

            // Full scan every 60s so identity and port findings can colour the badge.
            // Stats are the expensive part; 60s is the budget.
            spawn_badge_watcher(app.handle().clone(), 60);

            let h = app.handle().clone();
            if let Some(win) = app.get_webview_window(PANEL) {
                win.on_window_event(move |e| {
                    if let WindowEvent::Focused(false) = e {
                        if let Some(w) = h.get_webview_window(PANEL) {
                            let _ = w.hide();
                        }
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running slotyard");
}
