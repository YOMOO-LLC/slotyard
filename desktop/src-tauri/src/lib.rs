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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    /// Absolute path to monorepo / worktree root for doctor
    repo: Option<String>,
    /// Override path to cli.ts or slotyard binary
    cli: Option<String>,
    /// Poll interval while panel is open (seconds)
    poll_seconds: Option<u64>,
}

struct State {
    config: Mutex<AppConfig>,
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
            return c;
        }
    }
    AppConfig {
        repo: default_repo_guess(),
        poll_seconds: Some(5),
        ..Default::default()
    }
}

fn save_config(cfg: &AppConfig) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(path, raw).map_err(|e| e.to_string())
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

fn resolve_cli(cfg: &AppConfig) -> Result<PathBuf, String> {
    if let Some(ref p) = cfg.cli {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Ok(pb);
        }
        return Err(format!("CLI path does not exist: {p}"));
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let monorepo_cli = manifest.join("../../src/cli.ts");
    if monorepo_cli.exists() {
        return Ok(monorepo_cli.canonicalize().map_err(|e| e.to_string())?);
    }
    // Same trap as spawning node: a GUI process has launchd's stripped PATH, so
    // `which` would miss a CLI installed under homebrew or ~/.local/bin. This
    // fallback is what keeps the app working when the repo it was built from
    // moves or is removed.
    if let Ok(out) = Command::new("/usr/bin/which")
        .arg("slotyard")
        .env("PATH", user_path())
        .output()
    {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() {
                return Ok(PathBuf::from(s));
            }
        }
    }
    Err("Cannot find slotyard CLI. Keep monorepo layout or set cli path.".into())
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
    if let Ok(out) = Command::new("/bin/zsh").args(["-lc", "command -v node"]).output() {
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
fn set_repo(state: tauri::State<'_, State>, repo: String) -> Result<AppConfig, String> {
    let path = PathBuf::from(&repo);
    if !path.is_dir() {
        return Err(format!("Not a directory: {repo}"));
    }
    let mut cfg = state.config.lock().unwrap();
    cfg.repo = Some(
        path.canonicalize()
            .map_err(|e| e.to_string())?
            .display()
            .to_string(),
    );
    save_config(&cfg)?;
    Ok(cfg.clone())
}

#[tauri::command]
fn pick_repo(state: tauri::State<'_, State>) -> Result<AppConfig, String> {
    let folder = rfd::FileDialog::new()
        .set_title("Select monorepo / worktree root")
        .pick_folder()
        .ok_or_else(|| "cancelled".to_string())?;
    set_repo(state, folder.display().to_string())
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
) -> Result<serde_json::Value, String> {
    let cfg = state.config.lock().unwrap().clone();
    let repo = cfg
        .repo
        .clone()
        .ok_or_else(|| "No repo selected. Choose a monorepo folder.".to_string())?;
    let cwd = PathBuf::from(&repo);
    if !cwd.is_dir() {
        return Err(format!("Repo path missing: {repo}"));
    }
    let cli = resolve_cli(&cfg)?;
    let use_fast = fast.unwrap_or(true);
    let args: Vec<&str> = if use_fast {
        vec!["--json", "--fast"]
    } else {
        vec!["--json"]
    };
    let stdout = tauri::async_runtime::spawn_blocking(move || run_node_cli(&cli, &cwd, &args))
        .await
        .map_err(|e| format!("join error: {e}"))??;
    serde_json::from_str(&stdout).map_err(|e| format!("invalid doctor JSON: {e}\n{stdout}"))
}

#[tauri::command]
async fn run_lifecycle(
    state: tauri::State<'_, State>,
    action: String,
    slot: u32,
    role: Option<String>,
    dry_run: Option<bool>,
) -> Result<String, String> {
    if action != "wake" && action != "sleep" {
        return Err("action must be wake or sleep".into());
    }
    let cfg = state.config.lock().unwrap().clone();
    let repo = cfg
        .repo
        .clone()
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
fn apply_tray_state(app: &AppHandle, critical: u32, warning: u32, running: u32) -> Result<(), String> {
    let tray = app.tray_by_id("main").ok_or("tray missing")?;
    let (bytes, template): (&[u8], bool) = if critical > 0 {
        (include_bytes!("../icons/tray-critical.png"), false)
    } else if warning > 0 {
        (include_bytes!("../icons/tray-warning.png"), false)
    } else {
        (include_bytes!("../icons/tray.png"), true)
    };
    let icon = Image::from_bytes(bytes).map_err(|e| e.to_string())?;
    tray.set_icon(Some(icon)).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    tray.set_icon_as_template(template).map_err(|e| e.to_string())?;
    let tip = match (critical, warning) {
        (0, 0) => format!("slotyard — {running} running, all clear"),
        (0, w) => format!("slotyard — {running} running, {w} warning"),
        (c, 0) => format!("slotyard — {c} critical"),
        (c, w) => format!("slotyard — {c} critical, {w} warning"),
    };
    tray.set_tooltip(Some(&tip)).map_err(|e| e.to_string())?;
    Ok(())
}

/// While the panel is open the frontend reports its own counts, saving a scan.
#[tauri::command]
fn set_tray_state(app: AppHandle, critical: u32, warning: u32, running: u32) -> Result<(), String> {
    apply_tray_state(&app, critical, warning, running)
}

/// The badge cannot depend on the hidden webview. WebKit freezes its timers as
/// soon as the panel closes — and "know without opening it" is the only reason
/// this icon exists. So the scan runs here instead.
fn spawn_badge_watcher(app: AppHandle, every: u64) {
    std::thread::spawn(move || loop {
        let cfg = {
            let s: tauri::State<'_, State> = app.state();
            let c = s.config.lock().unwrap().clone();
            c
        };
        if let (Some(repo), Ok(cli)) = (cfg.repo.clone(), resolve_cli(&cfg)) {
            let cwd = PathBuf::from(&repo);
            if cwd.is_dir() {
                if let Ok(out) = run_node_cli(&cli, &cwd, &["--json", "--fast"]) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&out) {
                        let sev = |name: &str| {
                            v["findings"]
                                .as_array()
                                .map(|a| a.iter().filter(|f| f["severity"] == name).count() as u32)
                                .unwrap_or(0)
                        };
                        let running = v["slots"]
                            .as_array()
                            .map(|a| a.iter().filter(|s| s["running"] == true).count() as u32)
                            .unwrap_or(0);
                        let _ = apply_tray_state(&app, sev("critical"), sev("warning"), running);
                    }
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_secs(every));
    });
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
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            set_repo,
            pick_repo,
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

            let icon =
                Image::from_bytes(include_bytes!("../icons/tray.png")).expect("tray icon");

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

            // Every 60s, --fast only, so it keeps watching with the panel closed
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
