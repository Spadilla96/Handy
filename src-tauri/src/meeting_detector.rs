//! Detects Microsoft Teams meetings by watching Windows' microphone usage
//! records (`CapabilityAccessManager\ConsentStore\microphone`), which every
//! app's capture session updates without needing admin rights. When Teams
//! starts using the microphone we offer to record the meeting; when it has
//! released the microphone for a while, a meeting we auto-started is stopped
//! and saved.

use std::sync::Arc;
use std::time::{Duration, Instant};

use log::{debug, info, warn};
use tauri::{AppHandle, Emitter, Manager, WebviewWindowBuilder};

use crate::managers::meeting::MeetingManager;
use crate::settings::get_settings;

const POLL_INTERVAL: Duration = Duration::from_secs(3);
/// Teams must stay off the microphone this long before we stop recording
/// (brief releases happen when switching devices or rejoining).
const RELEASE_GRACE: Duration = Duration::from_secs(20);

pub const PROMPT_WINDOW_LABEL: &str = "meeting_prompt";
const PROMPT_WIDTH: f64 = 360.0;
const PROMPT_HEIGHT: f64 = 132.0;

/// `LastUsedTimeStart`/`LastUsedTimeStop` FILETIMEs of one consent entry.
/// An app is using the microphone while its last start is newer than its
/// last stop (Windows writes Stop = 0 while a session is open).
pub fn usage_in_progress(start: u64, stop: u64) -> bool {
    start > 0 && (stop == 0 || start > stop)
}

/// Whether any Teams build (new "MSTeams" package or classic desktop app)
/// currently holds the microphone.
#[cfg(target_os = "windows")]
pub fn teams_using_microphone() -> bool {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    const BASE: &str =
        r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

    fn entry_in_use(key: &RegKey) -> bool {
        let start: u64 = key.get_value("LastUsedTimeStart").unwrap_or(0);
        let stop: u64 = key.get_value("LastUsedTimeStop").unwrap_or(0);
        usage_in_progress(start, stop)
    }

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(root) = hkcu.open_subkey(BASE) else {
        return false;
    };
    // Packaged apps: new Teams is `MSTeams_8wekyb3d8bbwe`.
    for name in root.enum_keys().filter_map(|k| k.ok()) {
        if name.to_ascii_lowercase().starts_with("msteams") {
            if let Ok(key) = root.open_subkey(&name) {
                if entry_in_use(&key) {
                    return true;
                }
            }
        }
    }
    // Desktop apps are keyed by executable path with '#' separators, e.g.
    // `C:#Users#me#AppData#Local#Microsoft#Teams#current#Teams.exe`.
    if let Ok(non_packaged) = root.open_subkey("NonPackaged") {
        for name in non_packaged.enum_keys().filter_map(|k| k.ok()) {
            let lower = name.to_ascii_lowercase();
            if lower.ends_with("#teams.exe") || lower.ends_with("#ms-teams.exe") {
                if let Ok(key) = non_packaged.open_subkey(&name) {
                    if entry_in_use(&key) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

#[cfg(not(target_os = "windows"))]
pub fn teams_using_microphone() -> bool {
    false
}

/// Start the background polling thread (Windows only).
pub fn start(app: &AppHandle) {
    if !cfg!(target_os = "windows") {
        return;
    }
    let app = app.clone();
    std::thread::Builder::new()
        .name("meeting-detector".into())
        .spawn(move || run(app))
        .map_err(|e| warn!("Could not start the meeting detector: {e}"))
        .ok();
}

fn run(app: AppHandle) {
    let mut was_in_use = teams_using_microphone();
    let mut released_at: Option<Instant> = None;
    info!("Meeting detector running (Teams in use at start: {was_in_use})");
    loop {
        std::thread::sleep(POLL_INTERVAL);
        let in_use = teams_using_microphone();
        let manager = app.state::<Arc<MeetingManager>>();

        if in_use && !was_in_use {
            released_at = None;
            let enabled = get_settings(&app).meeting_detection_enabled;
            debug!("Teams started using the microphone (detection enabled: {enabled})");
            if enabled && !manager.is_active() {
                show_prompt(&app, "ask");
            }
        }

        if in_use {
            released_at = None;
        } else if manager.is_active() && manager.is_auto_started() {
            let since = *released_at.get_or_insert_with(Instant::now);
            if since.elapsed() >= RELEASE_GRACE {
                released_at = None;
                info!("Teams released the microphone; stopping the meeting recording");
                let app = app.clone();
                std::thread::spawn(move || {
                    let manager = app.state::<Arc<MeetingManager>>();
                    match manager.stop() {
                        Ok(_) => show_prompt(&app, "saved"),
                        Err(e) => warn!("Automatic meeting stop failed: {e:#}"),
                    }
                });
            }
        }

        if !in_use && was_in_use {
            // The meeting ended before the user answered: withdraw the offer.
            if !manager.is_active() {
                close_prompt(&app);
            }
        }
        was_in_use = in_use;
    }
}

/// Show the small corner prompt. `mode` is "ask" (offer to record) or
/// "saved" (confirmation after an automatic stop).
pub fn show_prompt(app: &AppHandle, mode: &str) {
    let app = app.clone();
    let mode = mode.to_string();
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(window) = app.get_webview_window(PROMPT_WINDOW_LABEL) {
            let _ = app.emit_to(PROMPT_WINDOW_LABEL, "meeting-prompt-mode", &mode);
            let _ = window.show();
            return;
        }
        let url = format!("src/meeting-prompt/index.html?mode={mode}");
        let mut builder =
            WebviewWindowBuilder::new(&app, PROMPT_WINDOW_LABEL, tauri::WebviewUrl::App(url.into()))
                .title("Handy")
                .inner_size(PROMPT_WIDTH, PROMPT_HEIGHT)
                .resizable(false)
                .maximizable(false)
                .minimizable(false)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .focused(false)
                .accept_first_mouse(true)
                .visible(true);
        if let Some(data_dir) = crate::portable::data_dir() {
            builder = builder.data_directory(data_dir.join("webview"));
        }
        // Bottom-right corner of the primary monitor's work area.
        if let Ok(Some(monitor)) = app.primary_monitor() {
            let scale = monitor.scale_factor();
            let area = monitor.work_area();
            let x = (area.position.x as f64 + area.size.width as f64) / scale - PROMPT_WIDTH - 16.0;
            let y =
                (area.position.y as f64 + area.size.height as f64) / scale - PROMPT_HEIGHT - 16.0;
            builder = builder.position(x, y);
        }
        if let Err(e) = builder.build() {
            warn!("Could not open the meeting prompt: {e}");
        }
    });
}

pub fn close_prompt(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(PROMPT_WINDOW_LABEL) {
        let _ = window.close();
    }
}

#[cfg(test)]
mod tests {
    use super::usage_in_progress;

    #[test]
    fn microphone_usage_state_from_filetimes() {
        // Never used.
        assert!(!usage_in_progress(0, 0));
        // Session open: Windows clears the stop time.
        assert!(usage_in_progress(133_000, 0));
        // Session open after an earlier one ended.
        assert!(usage_in_progress(133_500, 133_200));
        // Last session ended.
        assert!(!usage_in_progress(133_000, 133_400));
    }
}
