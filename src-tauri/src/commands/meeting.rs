use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, Manager};

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
pub fn rename_meeting(app: AppHandle, id: i64, name: String) -> Result<(), String> {
    manager(&app).rename(id, &name).map_err(err_string)
}

#[tauri::command]
#[specta::specta]
pub fn delete_meeting(app: AppHandle, id: i64) -> Result<(), String> {
    manager(&app).delete(id).map_err(err_string)
}

/// Delete only the recording, keeping the transcript.
#[tauri::command]
#[specta::specta]
pub fn delete_meeting_audio(app: AppHandle, id: i64) -> Result<(), String> {
    manager(&app).delete_audio(id).map_err(err_string)
}

/// Exempt (or not) the recording from the 7-day automatic deletion.
#[tauri::command]
#[specta::specta]
pub fn set_meeting_keep_audio(app: AppHandle, id: i64, keep: bool) -> Result<(), String> {
    manager(&app).set_keep_audio(id, keep).map_err(err_string)
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

/// The original (non-diarized) transcription of a meeting, kept in the history
/// entry it was created from.
#[tauri::command]
#[specta::specta]
pub async fn get_meeting_raw_transcript(app: AppHandle, id: i64) -> Result<String, String> {
    let m = manager(&app);
    let source = tokio::task::spawn_blocking(move || m.source_history_id_for(id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(err_string)?
        .ok_or_else(|| "no-source".to_string())?;
    let history = app.state::<Arc<HistoryManager>>().inner().clone();
    history
        .get_entry_by_id(source)
        .await
        .map_err(err_string)?
        .map(|e| e.transcription_text)
        .ok_or_else(|| "no-source".to_string())
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
    tokio::task::spawn_blocking(move || m.start_diarization(entry, None))
        .await
        .map_err(|e| e.to_string())?
        .map_err(err_string)
}

/// A recording flagged mid-session as a meeting: once its direct transcription
/// is saved, it is processed as a meeting (speaker separation) automatically.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
pub struct PendingMeeting {
    pub enabled: bool,
    pub name: String,
}

#[derive(Default)]
pub struct PendingMeetingState(pub Mutex<PendingMeeting>);

/// Replace the pending state and tell every window.
pub fn write_pending_meeting(app: &AppHandle, value: PendingMeeting) {
    *app.state::<PendingMeetingState>().0.lock().unwrap() = value.clone();
    let _ = app.emit("pending-meeting-changed", value);
}

/// Read and clear the flag (used when a recording ends).
pub fn take_pending_meeting(app: &AppHandle) -> PendingMeeting {
    let taken = std::mem::take(&mut *app.state::<PendingMeetingState>().0.lock().unwrap());
    if taken.enabled || !taken.name.is_empty() {
        let _ = app.emit("pending-meeting-changed", PendingMeeting::default());
    }
    taken
}

pub fn clear_pending_meeting(app: &AppHandle) {
    let _ = take_pending_meeting(app);
}

#[tauri::command]
#[specta::specta]
pub fn set_pending_meeting(app: AppHandle, enabled: bool, name: String) {
    write_pending_meeting(
        &app,
        PendingMeeting {
            enabled,
            name: if enabled { name } else { String::new() },
        },
    );
}

#[tauri::command]
#[specta::specta]
pub fn get_pending_meeting(app: AppHandle) -> PendingMeeting {
    let state = app.state::<PendingMeetingState>();
    let value = state.0.lock().unwrap().clone();
    value
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
