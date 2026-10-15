//! Mirrors the mute button of a Microsoft Teams call onto Handy's microphone.
//!
//! New Teams (WebView2) exposes the call controls through UI Automation. The
//! microphone button has the stable id `microphone-button`; its accessible name
//! flips between "mute" and "unmute" wording, which is the only state it
//! exposes. While a recording is in progress and a call window exists, every
//! change of that state mutes or unmutes Handy's microphone. Outside a call
//! nothing is touched, so the overlay button stays independent.

/// Whether a call button's accessible name means the microphone is muted
/// (`Some(true)`), live (`Some(false)`), or is not recognised (`None`).
///
/// The name describes the action the button performs: "Unmute" while muted,
/// "Mute" while live.
pub fn parse_muted(name: &str) -> Option<bool> {
    let name = name.to_lowercase();
    if name.contains("unmute") || name.contains("reactivar") {
        Some(true)
    } else if name.contains("mute") || name.contains("desactivar") {
        Some(false)
    } else {
        None
    }
}

/// Start the background watcher (Windows only; a no-op elsewhere).
pub fn start(app: &tauri::AppHandle) {
    #[cfg(windows)]
    {
        let app = app.clone();
        if let Err(e) = std::thread::Builder::new()
            .name("teams-mic-sync".into())
            .spawn(move || watch::run(app))
        {
            log::warn!("Failed to start the Teams mute watcher: {e}");
        }
    }
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(windows)]
mod watch {
    use super::parse_muted;
    use crate::managers::audio::AudioRecordingManager;
    use crate::settings::get_settings;
    use log::{debug, warn};
    use std::sync::Arc;
    use std::time::Duration;
    use tauri::{AppHandle, Manager};
    use windows::core::{BSTR, VARIANT};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, TreeScope_Children, TreeScope_Descendants,
        UIA_AutomationIdPropertyId,
    };

    const POLL_INTERVAL: Duration = Duration::from_millis(700);
    const TEAMS_WINDOW_CLASS: &str = "TeamsWebView";
    const MIC_BUTTON_ID: &str = "microphone-button";

    struct Teams {
        automation: IUIAutomation,
    }

    impl Teams {
        fn new() -> Option<Self> {
            // SAFETY: plain COM initialisation on this dedicated thread; an
            // already-initialised apartment is fine, so the result is ignored.
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                let automation: IUIAutomation =
                    CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
                Some(Self { automation })
            }
        }

        /// Accessible name of the call's microphone button, or `None` when no
        /// Teams call window is open.
        fn mic_button_name(&self) -> Option<String> {
            // SAFETY: UI Automation calls on interfaces owned by this thread.
            unsafe {
                let root = self.automation.GetRootElement().ok()?;
                let all = self.automation.CreateTrueCondition().ok()?;
                let windows = root.FindAll(TreeScope_Children, &all).ok()?;
                let id = self
                    .automation
                    .CreatePropertyCondition(
                        UIA_AutomationIdPropertyId,
                        &VARIANT::from(BSTR::from(MIC_BUTTON_ID)),
                    )
                    .ok()?;
                for i in 0..windows.Length().ok()? {
                    let Ok(window) = windows.GetElement(i) else {
                        continue;
                    };
                    let is_teams = window
                        .CurrentClassName()
                        .is_ok_and(|class| class.to_string() == TEAMS_WINDOW_CLASS);
                    if !is_teams {
                        continue;
                    }
                    if let Ok(button) = window.FindFirst(TreeScope_Descendants, &id) {
                        if let Ok(name) = button.CurrentName() {
                            return Some(name.to_string());
                        }
                    }
                }
                None
            }
        }
    }

    pub fn run(app: AppHandle) {
        let mut teams: Option<Teams> = None;
        // Last Teams mute state applied during this recording; `None` while no
        // call is detected, so joining a call mid-recording re-aligns.
        let mut last: Option<bool> = None;
        let mut warned_unknown = false;

        loop {
            std::thread::sleep(POLL_INTERVAL);

            let recorder = app.state::<Arc<AudioRecordingManager>>();
            if !get_settings(&app).teams_mic_sync || !recorder.is_recording() {
                last = None;
                continue;
            }

            if teams.is_none() {
                teams = Teams::new();
            }
            let Some(teams) = teams.as_ref() else {
                continue;
            };

            let muted = teams.mic_button_name().and_then(|name| {
                let parsed = parse_muted(&name);
                if parsed.is_none() && !warned_unknown {
                    warned_unknown = true;
                    warn!("Unrecognised Teams microphone button name: '{name}'");
                }
                parsed
            });

            match muted {
                Some(muted) if last != Some(muted) => {
                    last = Some(muted);
                    debug!(
                        "Teams microphone is now {}",
                        if muted { "muted" } else { "live" }
                    );
                    // Fails harmlessly when the source has no microphone.
                    let _ = recorder.set_mic_enabled(!muted, "teams");
                }
                Some(_) => {}
                None => last = None,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::parse_muted;

    #[test]
    fn spanish_names() {
        assert_eq!(parse_muted("Reactivar audio del micrófono"), Some(true));
        assert_eq!(parse_muted("Desactivar audio del micrófono"), Some(false));
    }

    #[test]
    fn english_names() {
        assert_eq!(parse_muted("Unmute mic (Ctrl+Shift+M)"), Some(true));
        assert_eq!(parse_muted("Mute mic (Ctrl+Shift+M)"), Some(false));
    }

    #[test]
    fn unknown_name_is_not_guessed() {
        assert_eq!(parse_muted("Encender la cámara"), None);
        assert_eq!(parse_muted(""), None);
    }
}
