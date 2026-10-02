use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::managers::history::HistoryManager;
use crate::managers::meeting::{
    err_string, DiarizationJob, Meeting, MeetingManager, MeetingModelsStatus, MeetingSummary,
};

fn manager(app: &AppHandle) -> Arc<MeetingManager> {
    app.state::<Arc<MeetingManager>>().inner().clone()
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

/// Start turning a history entry's recording into a meeting. Returns once the
/// worker is running; the outcome arrives as `meeting-saved` or
/// `meeting-diarize-failed`.
#[tauri::command]
#[specta::specta]
pub async fn diarize_history_entry(app: AppHandle, id: i64) -> Result<(), String> {
    let history = app.state::<Arc<HistoryManager>>().inner().clone();
    let entry = history
        .get_entry_by_id(id)
        .await
        .map_err(err_string)?
        .ok_or_else(|| format!("History entry {id} not found"))?;
    let m = manager(&app);
    tokio::task::spawn_blocking(move || m.start_diarization(entry))
        .await
        .map_err(|e| e.to_string())?
        .map_err(err_string)
}

#[tauri::command]
#[specta::specta]
pub fn cancel_meeting_diarization(app: AppHandle) {
    manager(&app).cancel_diarization();
}

#[tauri::command]
#[specta::specta]
pub fn get_diarization_job(app: AppHandle) -> Option<DiarizationJob> {
    manager(&app).current_job()
}
