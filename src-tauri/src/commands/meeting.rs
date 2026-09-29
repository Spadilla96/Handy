use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::managers::meeting::{
    err_string, Meeting, MeetingManager, MeetingModelsStatus, MeetingStatus, MeetingSummary,
};
use crate::meeting_detector;
use crate::settings::{get_settings, write_settings};

fn manager(app: &AppHandle) -> Arc<MeetingManager> {
    app.state::<Arc<MeetingManager>>().inner().clone()
}

#[tauri::command]
#[specta::specta]
pub async fn start_meeting(app: AppHandle, auto_started: bool) -> Result<(), String> {
    let m = manager(&app);
    tokio::task::spawn_blocking(move || m.start(auto_started))
        .await
        .map_err(|e| e.to_string())?
        .map_err(err_string)
}

/// Stops the recording and waits for the final transcript; returns the id of
/// the saved meeting.
#[tauri::command]
#[specta::specta]
pub async fn stop_meeting(app: AppHandle) -> Result<i64, String> {
    let m = manager(&app);
    tokio::task::spawn_blocking(move || m.stop())
        .await
        .map_err(|e| e.to_string())?
        .map_err(err_string)
}

#[tauri::command]
#[specta::specta]
pub fn get_meeting_status(app: AppHandle) -> MeetingStatus {
    manager(&app).status()
}

#[tauri::command]
#[specta::specta]
pub fn get_meeting_models_status(app: AppHandle) -> MeetingModelsStatus {
    manager(&app).models_status()
}

#[tauri::command]
#[specta::specta]
pub async fn download_meeting_models(app: AppHandle) -> Result<(), String> {
    manager(&app).download_models().await.map_err(err_string)
}

#[tauri::command]
#[specta::specta]
pub fn list_meetings(app: AppHandle) -> Result<Vec<MeetingSummary>, String> {
    manager(&app).list().map_err(err_string)
}

#[tauri::command]
#[specta::specta]
pub fn get_meeting(app: AppHandle, id: i64) -> Result<Meeting, String> {
    manager(&app).get(id).map_err(err_string)
}

#[tauri::command]
#[specta::specta]
pub fn rename_meeting_speaker(
    app: AppHandle,
    id: i64,
    speaker: i32,
    name: String,
) -> Result<(), String> {
    manager(&app)
        .rename_speaker(id, speaker, &name)
        .map_err(err_string)
}

#[tauri::command]
#[specta::specta]
pub fn rename_meeting(app: AppHandle, id: i64, title: String) -> Result<(), String> {
    manager(&app).rename(id, &title).map_err(err_string)
}

#[tauri::command]
#[specta::specta]
pub fn delete_meeting(app: AppHandle, id: i64) -> Result<(), String> {
    manager(&app).delete(id).map_err(err_string)
}

#[tauri::command]
#[specta::specta]
pub fn get_meeting_audio_path(app: AppHandle, id: i64) -> Result<String, String> {
    manager(&app)
        .audio_path(id)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(err_string)
}

#[tauri::command]
#[specta::specta]
pub fn export_meeting_markdown(app: AppHandle, id: i64) -> Result<String, String> {
    manager(&app).markdown(id).map_err(err_string)
}

/// Saves the Markdown export under Documents and returns its path.
#[tauri::command]
#[specta::specta]
pub fn save_meeting_markdown(app: AppHandle, id: i64) -> Result<String, String> {
    manager(&app)
        .save_markdown(id)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(err_string)
}

/// "Record" from the Teams prompt: close it and start an auto-stopping session.
#[tauri::command]
#[specta::specta]
pub async fn accept_meeting_prompt(app: AppHandle) -> Result<(), String> {
    meeting_detector::close_prompt(&app);
    let m = manager(&app);
    let result = tokio::task::spawn_blocking(move || m.start(true))
        .await
        .map_err(|e| e.to_string())?;
    if let Err(e) = &result {
        if e.to_string() == "models-missing" {
            // Take the user to the Meetings page to download the models.
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.show();
                let _ = main.set_focus();
            }
            let _ = tauri::Emitter::emit(&app, "meeting-open-page", ());
        }
    }
    result.map_err(err_string)
}

#[tauri::command]
#[specta::specta]
pub fn dismiss_meeting_prompt(app: AppHandle) {
    meeting_detector::close_prompt(&app);
}

#[tauri::command]
#[specta::specta]
pub fn change_meeting_detection_setting(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.meeting_detection_enabled = enabled;
    write_settings(&app, settings);
    Ok(())
}
