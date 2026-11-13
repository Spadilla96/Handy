use crate::actions::process_transcription_output;
use crate::managers::{
    history::{HistoryManager, PaginatedHistory},
    transcription::TranscriptionManager,
};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

/// Error returned when a re-transcription is requested while another runs.
/// The frontend matches on this exact string.
const RETRANSCRIBE_BUSY: &str = "retranscribe_busy";

/// Only one re-transcription may run at a time: they share one engine, and a
/// second run that loads a different model swaps it out from under the first
/// (their windows then get mixed between two models).
static RETRANSCRIBING: AtomicBool = AtomicBool::new(false);

/// Clears [`RETRANSCRIBING`] when dropped, however the command ends.
struct RetranscribeGuard;

impl RetranscribeGuard {
    fn acquire() -> Option<Self> {
        RETRANSCRIBING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self)
    }
}

impl Drop for RetranscribeGuard {
    fn drop(&mut self) {
        RETRANSCRIBING.store(false, Ordering::Release);
    }
}

/// Sent as `history-retranscribe-progress` after each window of a
/// re-transcription is done (and once with `done: 0` when it starts).
#[derive(Clone, Serialize)]
struct RetranscribeProgress {
    id: i64,
    done: usize,
    total: usize,
    elapsed_ms: u64,
    /// Everything transcribed so far, shown live while the rest runs.
    text: String,
}

#[tauri::command]
#[specta::specta]
pub async fn get_history_entries(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    cursor: Option<i64>,
    limit: Option<usize>,
) -> Result<PaginatedHistory, String> {
    history_manager
        .get_history_entries(cursor, limit)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn toggle_history_entry_saved(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    id: i64,
) -> Result<(), String> {
    history_manager
        .toggle_saved_status(id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn get_audio_file_path(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    file_name: String,
) -> Result<String, String> {
    let path = history_manager.get_audio_file_path(&file_name);
    path.to_str()
        .ok_or_else(|| "Invalid file path".to_string())
        .map(|s| s.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_history_entry(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    id: i64,
) -> Result<(), String> {
    history_manager
        .delete_entry(id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn retry_history_entry_transcription(
    app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    transcription_manager: State<'_, Arc<TranscriptionManager>>,
    id: i64,
    model: Option<String>,
    enhance: Option<bool>,
) -> Result<(), String> {
    let _guard = RetranscribeGuard::acquire().ok_or_else(|| RETRANSCRIBE_BUSY.to_string())?;

    let entry = history_manager
        .get_entry_by_id(id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("History entry {} not found", id))?;

    let audio_path = history_manager.get_audio_file_path(&entry.file_name);
    let mut samples = crate::audio_toolkit::read_wav_samples(&audio_path)
        .map_err(|e| format!("Failed to load audio: {}", e))?;

    if samples.is_empty() {
        return Err("Recording has no audio samples".to_string());
    }

    // Optional: high-pass + volume normalization for distant voices. Only the
    // copy fed to the model is changed; the recording on disk is untouched.
    if enhance.unwrap_or(false) {
        samples = crate::audio_toolkit::enhance::enhance_speech(&samples);
    }

    // `model` overrides the selected model for this re-transcription only.
    let model = model.filter(|m| !m.is_empty());
    if model.is_none() {
        transcription_manager.initiate_model_load();
    }

    // Long recordings (meetings) must not be fed to the model in one go: its
    // compute graph grows with the audio length (a 47 min meeting asked for a
    // 127 GB buffer and failed). Transcribe in short windows and join them.
    let tm = Arc::clone(&transcription_manager);
    let progress_app = app.clone();
    let transcription = tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<String> {
        let override_model = match &model {
            Some(m) if tm.get_current_model().as_deref() != Some(m.as_str()) => {
                tm.load_model(m)?;
                true
            }
            _ => false,
        };

        let result = (|| -> anyhow::Result<String> {
            let mut parts: Vec<String> = Vec::new();
            let chunks = split_at_quiet_points(&samples);
            let total = chunks.len();
            let started = std::time::Instant::now();
            let emit = |done: usize, parts: &[String]| {
                let _ = progress_app.emit(
                    "history-retranscribe-progress",
                    RetranscribeProgress {
                        id,
                        done,
                        total,
                        elapsed_ms: started.elapsed().as_millis() as u64,
                        text: parts.join(" "),
                    },
                );
            };
            emit(0, &parts);
            for (i, chunk) in chunks.into_iter().enumerate() {
                let text = tm.transcribe(chunk.to_vec())?;
                let text = text.trim();
                if !text.is_empty() {
                    parts.push(text.to_string());
                }
                emit(i + 1, &parts);
            }
            Ok(parts.join(" "))
        })();

        // Go back to the selected model the next time one is needed.
        if override_model {
            tm.reload_model_on_next_use();
        }
        result
    })
    .await
    .map_err(|e| format!("Transcription task panicked: {}", e))?
    .map_err(|e| e.to_string())?;

    if transcription.is_empty() {
        return Err("Recording contains no speech".to_string());
    }

    let processed =
        process_transcription_output(&app, &transcription, entry.post_process_requested).await;
    history_manager
        .update_transcription(
            id,
            transcription,
            processed.post_processed_text,
            processed.post_process_prompt,
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Sample rate of the audio returned by `read_wav_samples`.
const SAMPLE_RATE: usize = 16_000;
/// Target window length fed to the model per call.
const CHUNK_SECS: usize = 60;
/// How far before the target boundary we look for a quiet spot to cut at.
const SEARCH_SECS: usize = 5;

/// Split `samples` into windows of about `CHUNK_SECS`, cutting each one at the
/// quietest 50 ms frame in the last `SEARCH_SECS` so words aren't split.
fn split_at_quiet_points(samples: &[f32]) -> Vec<&[f32]> {
    let chunk = CHUNK_SECS * SAMPLE_RATE;
    let search = SEARCH_SECS * SAMPLE_RATE;
    let frame = SAMPLE_RATE / 20;
    let mut out = Vec::new();
    let mut start = 0;
    while start < samples.len() {
        let target = start + chunk;
        if target >= samples.len() {
            out.push(&samples[start..]);
            break;
        }
        let from = target - search;
        let mut best = target;
        let mut best_energy = f32::MAX;
        let mut pos = from;
        while pos + frame <= target {
            let energy: f32 = samples[pos..pos + frame].iter().map(|s| s * s).sum();
            if energy < best_energy {
                best_energy = energy;
                best = pos + frame / 2;
            }
            pos += frame;
        }
        out.push(&samples[start..best]);
        start = best;
    }
    out
}

#[tauri::command]
#[specta::specta]
pub async fn update_history_limit(
    app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    limit: usize,
) -> Result<(), String> {
    let mut settings = crate::settings::get_settings(&app);
    settings.history_limit = limit;
    crate::settings::write_settings(&app, settings);

    history_manager
        .cleanup_old_entries()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn update_recording_retention_period(
    app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    period: String,
) -> Result<(), String> {
    use crate::settings::RecordingRetentionPeriod;

    let retention_period = match period.as_str() {
        "never" => RecordingRetentionPeriod::Never,
        "preserve_limit" => RecordingRetentionPeriod::PreserveLimit,
        "days3" => RecordingRetentionPeriod::Days3,
        "weeks2" => RecordingRetentionPeriod::Weeks2,
        "months3" => RecordingRetentionPeriod::Months3,
        _ => return Err(format!("Invalid retention period: {}", period)),
    };

    let mut settings = crate::settings::get_settings(&app);
    settings.recording_retention_period = retention_period;
    crate::settings::write_settings(&app, settings);

    history_manager
        .cleanup_old_entries()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_audio_is_one_chunk() {
        let samples = vec![0.1f32; 10 * SAMPLE_RATE];
        let chunks = split_at_quiet_points(&samples);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].len(), samples.len());
    }

    #[test]
    fn long_audio_is_split_without_losing_samples() {
        let samples = vec![0.1f32; 47 * 60 * SAMPLE_RATE];
        let chunks = split_at_quiet_points(&samples);
        assert!(chunks.len() > 40);
        assert_eq!(chunks.iter().map(|c| c.len()).sum::<usize>(), samples.len());
        let max = (CHUNK_SECS + 1) * SAMPLE_RATE;
        assert!(chunks.iter().all(|c| !c.is_empty() && c.len() <= max));
    }

    #[test]
    fn cuts_at_the_quiet_spot() {
        // Loud everywhere except a silent 50 ms frame ~2 s before the target.
        let mut samples = vec![0.5f32; 130 * SAMPLE_RATE];
        let quiet = CHUNK_SECS * SAMPLE_RATE - 2 * SAMPLE_RATE;
        samples[quiet..quiet + SAMPLE_RATE / 20].fill(0.0);
        let chunks = split_at_quiet_points(&samples);
        let first = chunks[0].len();
        assert!(first >= quiet && first <= quiet + SAMPLE_RATE / 20);
    }
}
