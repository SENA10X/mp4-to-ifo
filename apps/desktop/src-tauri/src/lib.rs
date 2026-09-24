// MP4 to IFO desktop: Tauri backend. It runs the bundled engine (bundled node + the conversion core) as
// a child process and relays its JSON lines to the UI. It never runs ffmpeg itself.
//
// Process lifecycle (no orphaned ffmpeg on normal exit paths):
// - The engine runs in its own process group; ffmpeg, ffprobe, dvdauthor and caffeinate are its children.
// - Cancel: "cancel" on the engine's stdin -> the core stops its children, cleans up, and the engine exits.
// - Close window / Cmd+Q while converting: exit is held back and the UI asks. "Cancel and Quit" cancels,
//   waits for the engine to finish cleaning up, then exits. Cmd+Q is the app's own Quit menu item: the
//   standard one calls -[NSApp terminate:], which Tauri cannot hold back.
// - Any other exit (e.g. logging out): the engine is cancelled and given a few seconds to clean up, then
//   its process group is killed.
// - This process killed (kill -9, crash): the engine sees stdin close and aborts on its own.

use serde::Serialize;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, State, WindowEvent};

/// How long "Cancel and Quit" waits for the engine to clean up before force-killing its process group.
const QUIT_CLEANUP_TIMEOUT: Duration = Duration::from_secs(20);
/// The same, when the app is terminated without asking (the system is logging out or shutting down).
const EXIT_CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);

struct Running {
    child: Arc<Mutex<Child>>,
    stdin: ChildStdin,
    pid: i32,
}

#[derive(Default)]
struct Conversion {
    running: Mutex<Option<Running>>,
    quitting: AtomicBool,
}

impl Conversion {
    fn is_running(&self) -> bool {
        self.running.lock().map(|r| r.is_some()).unwrap_or(false)
    }
}

/// Bundled executables live next to the app binary (Contents/MacOS); never on PATH.
fn tools_dir() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "no executable directory".into())
}

fn engine_command(app: &AppHandle, args: &[&str]) -> Result<Command, String> {
    let tools = tools_dir()?;
    let engine = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("engine/engine.js");
    let version = app.package_info().version.to_string();
    let mut cmd = Command::new(tools.join("node"));
    cmd.arg(engine)
        .args(args)
        .arg("--tools")
        .arg(&tools)
        .arg("--app-version")
        .arg(version)
        // A clean environment: nothing from the user's shell, no Homebrew on PATH.
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("HOME", std::env::var("HOME").unwrap_or_default())
        .env("TMPDIR", std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".into()))
        .env("LANG", "en_US.UTF-8")
        .process_group(0);
    Ok(cmd)
}

/// Analyze an MP4 and return the engine's plan (or error) message.
#[tauri::command]
async fn analyze(app: AppHandle, input: String, output_dir: Option<String>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut args = vec!["analyze", input.as_str()];
        if let Some(dir) = output_dir.as_deref() {
            args.push("--output");
            args.push(dir);
        }
        let output = engine_command(&app, &args)?.stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let line = stdout.lines().last().ok_or("the engine returned nothing")?;
        serde_json::from_str(line).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum EngineExit {
    Exit { code: Option<i32> },
}

/// Start a conversion. Progress, the result and errors arrive as "engine" events.
/// Only the user's choices cross this boundary: the input, the output folder and the digest of the plan
/// they saw. The engine's core plans again and refuses to convert if that plan differs.
#[tauri::command]
fn start_conversion(
    app: AppHandle,
    state: State<'_, Arc<Conversion>>,
    input: String,
    output_dir: String,
    plan_digest: String,
) -> Result<(), String> {
    let mut slot = state.running.lock().map_err(|e| e.to_string())?;
    if slot.is_some() {
        return Err("a conversion is already running".into());
    }
    let mut child = engine_command(&app, &["convert"])?
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let job = serde_json::json!({ "input": input, "outputDirectory": output_dir, "planDigest": plan_digest });
    writeln!(stdin, "{job}").map_err(|e| e.to_string())?;
    let pid = child.id() as i32;
    let child = Arc::new(Mutex::new(child));
    *slot = Some(Running { child: child.clone(), stdin, pid });
    drop(slot);

    let state = state.inner().clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) {
                let _ = app.emit("engine", message);
            }
        }
        let code = child.lock().ok().and_then(|mut c| c.wait().ok()).and_then(|s| s.code());
        // The engine is gone; make sure nothing it started is left in its group.
        unsafe { libc::killpg(pid, libc::SIGKILL) };
        if let Ok(mut slot) = state.running.lock() {
            *slot = None;
        }
        let _ = app.emit("engine", EngineExit::Exit { code });
        if state.quitting.load(Ordering::SeqCst) {
            app.exit(0);
        }
    });
    Ok(())
}

/// Ask the engine to cancel; it stops ffmpeg, removes partial output and exits.
#[tauri::command]
fn cancel_conversion(state: State<'_, Arc<Conversion>>) -> Result<(), String> {
    if let Some(running) = state.running.lock().map_err(|e| e.to_string())?.as_mut() {
        let _ = writeln!(running.stdin, "cancel");
    }
    Ok(())
}

/// "Cancel and Quit": cancel, wait for cleanup (bounded), then exit.
#[tauri::command]
fn cancel_and_quit(app: AppHandle, state: State<'_, Arc<Conversion>>) -> Result<(), String> {
    state.quitting.store(true, Ordering::SeqCst);
    if !state.is_running() {
        app.exit(0);
        return Ok(());
    }
    let state = state.inner().clone();
    std::thread::spawn(move || {
        stop_engine(&state, QUIT_CLEANUP_TIMEOUT);
        app.exit(0);
    });
    Ok(())
}

/// Close window or Cmd+Q: ask first while converting, otherwise quit.
fn request_quit<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<Arc<Conversion>>();
    if state.is_running() && !state.quitting.load(Ordering::SeqCst) {
        let _ = app.emit("quit-requested", ());
    } else {
        app.exit(0);
    }
}

/// Cancel the engine and wait (bounded) for it to clean up, then kill whatever is left.
fn stop_engine(state: &Conversion, timeout: Duration) {
    if let Ok(mut slot) = state.running.lock() {
        if let Some(running) = slot.as_mut() {
            let _ = writeln!(running.stdin, "cancel");
        }
    }
    let started = Instant::now();
    while state.is_running() && started.elapsed() < timeout {
        std::thread::sleep(Duration::from_millis(100));
    }
    kill_engine(state);
}

/// Last resort: kill the engine's whole process group (engine, ffmpeg, dvdauthor, caffeinate).
fn kill_engine(state: &Conversion) {
    if let Ok(mut slot) = state.running.lock() {
        if let Some(running) = slot.take() {
            unsafe { libc::killpg(running.pid, libc::SIGKILL) };
            if let Ok(mut child) = running.child.lock() {
                let _ = child.wait();
            }
        }
    }
}

#[derive(Serialize)]
struct License {
    name: String,
    text: String,
}

/// Licenses shipped in the bundle (third-party/licenses and the app's own MIT license).
#[tauri::command]
fn read_licenses(app: AppHandle) -> Result<Vec<License>, String> {
    let dir = app.path().resource_dir().map_err(|e| e.to_string())?.join("licenses");
    let mut entries: Vec<_> = std::fs::read_dir(&dir).map_err(|e| e.to_string())?.filter_map(Result::ok).collect();
    entries.sort_by_key(|e| e.file_name());
    Ok(entries
        .into_iter()
        .filter_map(|e| {
            let text = std::fs::read_to_string(e.path()).ok()?;
            Some(License { name: e.file_name().to_string_lossy().into_owned(), text })
        })
        .collect())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let conversion = Arc::new(Conversion::default());
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(conversion.clone())
        .menu(|app| {
            let name = app.package_info().name.clone();
            let quit = MenuItem::with_id(app, "quit", format!("Quit {name}"), true, Some("CmdOrCtrl+Q"))?;
            let app_menu = Submenu::with_items(
                app,
                &name,
                true,
                &[
                    &PredefinedMenuItem::about(app, None, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::show_all(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &quit,
                ],
            )?;
            let edit = Submenu::with_items(app, "Edit", true, &[&PredefinedMenuItem::copy(app, None)?, &PredefinedMenuItem::select_all(app, None)?])?;
            let window = Submenu::with_items(app, "Window", true, &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::close_window(app, None)?])?;
            Menu::with_items(app, &[&app_menu, &edit, &window])
        })
        .on_menu_event(|app, event| {
            if event.id() == "quit" {
                request_quit(app);
            }
        })
        .invoke_handler(tauri::generate_handler![analyze, start_conversion, cancel_conversion, cancel_and_quit, read_licenses])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Closing the only window quits the app (after asking, while converting).
                api.prevent_close();
                request_quit(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the app");

    app.run(move |handle, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            let state = handle.state::<Arc<Conversion>>();
            if state.is_running() && !state.quitting.load(Ordering::SeqCst) {
                api.prevent_exit();
                let _ = handle.emit("quit-requested", ());
            }
        }
        RunEvent::Exit => stop_engine(&conversion, EXIT_CLEANUP_TIMEOUT),
        _ => {}
    });
}
