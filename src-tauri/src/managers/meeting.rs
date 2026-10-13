//! Meetings: turn a finished dictation recording into a speaker-attributed
//! transcript. The recording's WAV is handed to `handy-meeting-worker` (a
//! separate process running NeMo's ASR and Nemotron-3-Diarization), and the
//! result is kept in `meetings.db` with its own copy of the audio, outside the
//! dictation history's retention limits.
//!
//! The worker is out of process on purpose: NeMo ships its own `ggml*.dll`
//! builds, which would collide with the ones transcribe-cpp already loaded
//! into Handy.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use futures_util::StreamExt;
use log::{debug, error, info, warn};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, Manager};

use crate::managers::history::{HistoryEntry, HistoryManager};

// ---- Models -----------------------------------------------------------------

struct ModelSpec {
    file: &'static str,
    url: &'static str,
    size: u64,
}

const ASR_MODEL: ModelSpec = ModelSpec {
    file: "nemotron-3.5-asr-streaming-0.6b.q8_0.gguf",
    url: "https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b/resolve/main/nemotron-3.5-asr-streaming-0.6b.q8_0.gguf",
    size: 742_090_464,
};

const DIAR_MODEL: ModelSpec = ModelSpec {
    file: "Nemotron-3-Diarization.q8_0.gguf",
    url: "https://huggingface.co/nvidia/Nemotron-3-Diarization/resolve/main/Nemotron-3-Diarization.q8_0.gguf",
    size: 107_012_128,
};

const MODELS: [&ModelSpec; 2] = [&ASR_MODEL, &DIAR_MODEL];

#[derive(Clone, Debug, Serialize, Type)]
pub struct MeetingModelsStatus {
    pub ready: bool,
    pub downloading: bool,
    pub downloaded: u64,
    pub total: u64,
}

// ---- Transcript types ---------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq)]
pub struct Utterance {
    /// 1-based diarizer speaker id; 0 = unknown.
    pub speaker: i32,
    pub start: f64,
    pub end: f64,
    pub text: String,
    #[serde(default)]
    pub provisional: bool,
}

/// How long a meeting keeps its recording after diarization, unless it is
/// marked to keep it.
const AUDIO_RETENTION_SECS: i64 = 7 * 24 * 3600;

#[derive(Clone, Debug, Serialize, Type)]
pub struct MeetingSummary {
    pub id: i64,
    pub started_at: i64,
    pub ended_at: i64,
    /// Date prefix plus the user's name, e.g. "Reunión 2026-10-09 18:06 - Diana".
    pub title: String,
    /// The user part of the title; empty if never named.
    pub name: String,
    pub speaker_count: u32,
    pub preview: String,
    /// History entry this meeting was created from, if any.
    pub source_history_id: Option<i64>,
    pub keep_audio: bool,
    pub audio_available: bool,
    /// When the recording will be deleted automatically, if it will.
    pub audio_expires_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Type)]
pub struct Meeting {
    pub id: i64,
    pub started_at: i64,
    pub ended_at: i64,
    pub title: String,
    pub name: String,
    pub file_name: String,
    pub utterances: Vec<Utterance>,
    /// Speaker id (as a string) -> display name.
    pub speaker_names: HashMap<String, String>,
    pub keep_audio: bool,
    pub audio_available: bool,
    pub audio_expires_at: Option<i64>,
}

// ---- Diarization job ------------------------------------------------------------

/// The diarization currently running, also sent as `meeting-diarize-progress`.
#[derive(Clone, Debug, Serialize, Type)]
pub struct DiarizationJob {
    pub history_id: i64,
    /// 0.0..=1.0 of the recording processed.
    pub progress: f64,
    pub backend: Option<String>,
}

/// Sent as `meeting-saved` when a diarization finishes.
#[derive(Clone, Debug, Serialize, Type)]
pub struct MeetingSavedEvent {
    pub history_id: i64,
    pub meeting_id: i64,
}

/// Sent as `meeting-diarize-failed` when a diarization errors or is cancelled.
#[derive(Clone, Debug, Serialize, Type)]
pub struct DiarizeFailedEvent {
    pub history_id: i64,
    pub message: String,
    pub cancelled: bool,
}

struct RunningJob {
    info: DiarizationJob,
    child: Arc<Mutex<Child>>,
    cancelled: bool,
}

pub struct MeetingManager {
    app: AppHandle,
    db_path: PathBuf,
    models_dir: PathBuf,
    job: Mutex<Option<RunningJob>>,
    downloading: Mutex<bool>,
    download_progress: Mutex<(u64, u64)>,
}

impl MeetingManager {
    pub fn new(app: &AppHandle) -> Result<Self> {
        let data_dir = crate::portable::app_data_dir(app)?;
        let models_dir = data_dir.join("models").join("meeting");
        std::fs::create_dir_all(&models_dir)?;
        let manager = Self {
            app: app.clone(),
            db_path: data_dir.join("meetings.db"),
            models_dir,
            job: Mutex::new(None),
            downloading: Mutex::new(false),
            download_progress: Mutex::new((0, 0)),
        };
        manager.init_db()?;
        Ok(manager)
    }

    // ---- storage ----------------------------------------------------------

    fn conn(&self) -> Result<Connection> {
        Ok(Connection::open(&self.db_path)?)
    }

    fn init_db(&self) -> Result<()> {
        let conn = self.conn()?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS meetings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                started_at INTEGER NOT NULL,
                ended_at INTEGER NOT NULL,
                title TEXT NOT NULL,
                file_name TEXT NOT NULL,
                utterances_json TEXT NOT NULL,
                speaker_names_json TEXT NOT NULL DEFAULT '{}'
            );",
        )?;
        if !has_column(&conn, "source_history_id")? {
            conn.execute_batch("ALTER TABLE meetings ADD COLUMN source_history_id INTEGER;")?;
        }
        if !has_column(&conn, "name")? {
            conn.execute_batch("ALTER TABLE meetings ADD COLUMN name TEXT NOT NULL DEFAULT '';")?;
            // Recover the user part of titles renamed before names existed.
            let rows: Vec<(i64, i64, String)> = conn
                .prepare("SELECT id, started_at, title FROM meetings")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<rusqlite::Result<_>>()?;
            for (id, started_at, title) in rows {
                let name = name_from_legacy_title(started_at, &title);
                if !name.is_empty() {
                    conn.execute(
                        "UPDATE meetings SET name = ?1 WHERE id = ?2",
                        params![name, id],
                    )?;
                }
            }
        }
        if !has_column(&conn, "keep_audio")? {
            conn.execute_batch(
                "ALTER TABLE meetings ADD COLUMN keep_audio INTEGER NOT NULL DEFAULT 0;",
            )?;
        }
        if !has_column(&conn, "diarized_at")? {
            // Meetings that predate retention get their full grace period
            // from the moment this version first runs.
            conn.execute_batch("ALTER TABLE meetings ADD COLUMN diarized_at INTEGER;")?;
            conn.execute(
                "UPDATE meetings SET diarized_at = ?1",
                params![chrono::Utc::now().timestamp()],
            )?;
        }
        Ok(())
    }

    fn audio_available(&self, file_name: &str) -> bool {
        !file_name.is_empty() && self.recordings_dir().join(file_name).exists()
    }

    pub fn list(&self) -> Result<Vec<MeetingSummary>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, started_at, ended_at, name, utterances_json, source_history_id, file_name, keep_audio, diarized_at FROM meetings ORDER BY started_at DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                (
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<i64>>(5)?,
                ),
                (
                    r.get::<_, String>(6)?,
                    r.get::<_, bool>(7)?,
                    r.get::<_, Option<i64>>(8)?,
                ),
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (
                (id, started_at, ended_at, name, json, source_history_id),
                (file_name, keep_audio, diarized_at),
            ) = row?;
            let audio_available = self.audio_available(&file_name);
            let utterances: Vec<Utterance> = serde_json::from_str(&json).unwrap_or_default();
            let mut speakers: Vec<i32> = utterances.iter().map(|u| u.speaker).collect();
            speakers.sort_unstable();
            speakers.dedup();
            let preview = utterances
                .iter()
                .map(|u| u.text.as_str())
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(160)
                .collect();
            out.push(MeetingSummary {
                id,
                started_at,
                ended_at,
                title: compose_title(started_at, &name),
                name,
                speaker_count: speakers.len() as u32,
                preview,
                source_history_id,
                keep_audio,
                audio_available,
                audio_expires_at: audio_expires_at(diarized_at, keep_audio, audio_available),
            });
        }
        Ok(out)
    }

    pub fn get(&self, id: i64) -> Result<Meeting> {
        let conn = self.conn()?;
        let (started_at, ended_at, name, file_name, utt, names, keep_audio, diarized_at): (
            i64,
            i64,
            String,
            String,
            String,
            String,
            bool,
            Option<i64>,
        ) = conn.query_row(
            "SELECT started_at, ended_at, name, file_name, utterances_json, speaker_names_json, keep_audio, diarized_at FROM meetings WHERE id = ?1",
            params![id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                ))
            },
        )?;
        let audio_available = self.audio_available(&file_name);
        Ok(Meeting {
            id,
            started_at,
            ended_at,
            title: compose_title(started_at, &name),
            name,
            file_name,
            utterances: serde_json::from_str(&utt).unwrap_or_default(),
            speaker_names: serde_json::from_str(&names).unwrap_or_default(),
            keep_audio,
            audio_available,
            audio_expires_at: audio_expires_at(diarized_at, keep_audio, audio_available),
        })
    }

    pub fn rename_speaker(&self, id: i64, speaker: i32, name: &str) -> Result<()> {
        let mut meeting = self.get(id)?;
        let key = speaker.to_string();
        if name.trim().is_empty() {
            meeting.speaker_names.remove(&key);
        } else {
            meeting.speaker_names.insert(key, name.trim().to_string());
        }
        self.conn()?.execute(
            "UPDATE meetings SET speaker_names_json = ?1 WHERE id = ?2",
            params![serde_json::to_string(&meeting.speaker_names)?, id],
        )?;
        Ok(())
    }

    /// Set the user part of the title; the date prefix always stays.
    pub fn rename(&self, id: i64, name: &str) -> Result<()> {
        let started_at: i64 = self.conn()?.query_row(
            "SELECT started_at FROM meetings WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        let name = name.trim();
        self.conn()?.execute(
            "UPDATE meetings SET name = ?1, title = ?2 WHERE id = ?3",
            params![name, compose_title(started_at, name), id],
        )?;
        Ok(())
    }

    pub fn delete(&self, id: i64) -> Result<()> {
        if let Err(e) = self.delete_audio(id) {
            warn!("Could not delete the recording of meeting #{id}: {e:#}");
        }
        self.conn()?
            .execute("DELETE FROM meetings WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Exempt a meeting's recording from automatic deletion, or not.
    pub fn set_keep_audio(&self, id: i64, keep: bool) -> Result<()> {
        self.conn()?.execute(
            "UPDATE meetings SET keep_audio = ?1 WHERE id = ?2",
            params![keep, id],
        )?;
        Ok(())
    }

    /// Remove a meeting's recording but keep its transcript.
    pub fn delete_audio(&self, id: i64) -> Result<()> {
        let file_name: String = self.conn()?.query_row(
            "SELECT file_name FROM meetings WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        if !file_name.is_empty() {
            let path = self.recordings_dir().join(&file_name);
            if path.exists() {
                std::fs::remove_file(&path)
                    .with_context(|| format!("deleting {}", path.display()))?;
            }
        }
        self.conn()?.execute(
            "UPDATE meetings SET file_name = '' WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// Delete recordings whose retention period has run out, unless the
    /// meeting is marked to keep its audio. Returns how many were removed.
    pub fn cleanup_expired_audio(&self) -> Result<usize> {
        let now = chrono::Utc::now().timestamp();
        let ids: Vec<i64> = self
            .conn()?
            .prepare(
                "SELECT id FROM meetings WHERE keep_audio = 0 AND file_name != '' AND diarized_at IS NOT NULL AND diarized_at <= ?1",
            )?
            .query_map(params![now - AUDIO_RETENTION_SECS], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let mut removed = 0;
        for id in ids {
            match self.delete_audio(id) {
                Ok(()) => removed += 1,
                Err(e) => warn!("Could not delete expired audio of meeting #{id}: {e:#}"),
            }
        }
        if removed > 0 {
            info!("Deleted the recordings of {removed} meeting(s) past their retention period");
            let _ = self.app.emit("meeting-audio-cleaned", removed);
        }
        Ok(removed)
    }

    /// Run `cleanup_expired_audio` now and then every hour; Handy usually
    /// stays in the tray for days.
    pub fn start_audio_cleanup(self: &Arc<Self>) {
        let manager = self.clone();
        std::thread::spawn(move || loop {
            if let Err(e) = manager.cleanup_expired_audio() {
                error!("Meeting audio cleanup failed: {e:#}");
            }
            std::thread::sleep(Duration::from_secs(3600));
        });
    }

    pub fn audio_path(&self, id: i64) -> Result<PathBuf> {
        let meeting = self.get(id)?;
        if !meeting.audio_available {
            bail!("The recording of this meeting was deleted");
        }
        Ok(self.recordings_dir().join(meeting.file_name))
    }

    /// Markdown export with speaker names applied.
    pub fn markdown(&self, id: i64) -> Result<String> {
        let m = self.get(id)?;
        let started = chrono::DateTime::from_timestamp(m.started_at, 0)
            .map(|t| t.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string())
            .unwrap_or_default();
        let mut out = format!("# {}\n\n_{}_\n\n", m.title, started);
        for u in &m.utterances {
            let name = speaker_label(&m.speaker_names, u.speaker);
            out.push_str(&format!(
                "**[{}] {}:** {}\n\n",
                format_ts(u.start),
                name,
                u.text
            ));
        }
        Ok(out)
    }

    /// Write the Markdown export to `Documents/Handy Reuniones/` and return
    /// the file path.
    pub fn save_markdown(&self, id: i64) -> Result<PathBuf> {
        let m = self.get(id)?;
        let dir = self
            .app
            .path()
            .document_dir()
            .context("no Documents folder")?
            .join("Handy Reuniones");
        std::fs::create_dir_all(&dir)?;
        let safe: String = m
            .title
            .chars()
            .map(|c| if "\\/:*?\"<>|".contains(c) { '-' } else { c })
            .collect();
        let path = dir.join(format!("{}.md", safe.trim()));
        std::fs::write(&path, self.markdown(id)?)?;
        Ok(path)
    }

    fn recordings_dir(&self) -> PathBuf {
        self.app
            .state::<Arc<HistoryManager>>()
            .recordings_dir()
            .to_path_buf()
    }

    // ---- models -------------------------------------------------------------

    fn model_path(&self, spec: &ModelSpec) -> PathBuf {
        self.models_dir.join(spec.file)
    }

    fn model_ready(&self, spec: &ModelSpec) -> bool {
        std::fs::metadata(self.model_path(spec))
            .map(|m| m.len() == spec.size)
            .unwrap_or(false)
    }

    pub fn models_status(&self) -> MeetingModelsStatus {
        let (downloaded, total) = *self.download_progress.lock().unwrap();
        MeetingModelsStatus {
            ready: MODELS.iter().all(|m| self.model_ready(m)),
            downloading: *self.downloading.lock().unwrap(),
            downloaded,
            total,
        }
    }

    /// Download any missing meeting model, emitting `meeting-models-progress`.
    pub async fn download_models(&self) -> Result<()> {
        {
            let mut d = self.downloading.lock().unwrap();
            if *d {
                bail!("A download is already in progress");
            }
            *d = true;
        }
        let result = self.download_missing().await;
        *self.downloading.lock().unwrap() = false;
        let _ = self.app.emit("meeting-models-progress", self.models_status());
        result
    }

    async fn download_missing(&self) -> Result<()> {
        let missing: Vec<&ModelSpec> = MODELS
            .iter()
            .copied()
            .filter(|m| !self.model_ready(m))
            .collect();
        let total: u64 = missing.iter().map(|m| m.size).sum();
        let mut done_before = 0u64;
        *self.download_progress.lock().unwrap() = (0, total);
        let client = reqwest::Client::new();
        for spec in missing {
            let dest = self.model_path(spec);
            let part = dest.with_extension("gguf.part");
            info!("Downloading meeting model {}", spec.file);
            let resp = client
                .get(spec.url)
                .send()
                .await?
                .error_for_status()
                .with_context(|| format!("downloading {}", spec.file))?;
            let mut file = std::io::BufWriter::new(std::fs::File::create(&part)?);
            let mut stream = resp.bytes_stream();
            let mut got = 0u64;
            let mut last_emit = Instant::now();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk?;
                file.write_all(&chunk)?;
                got += chunk.len() as u64;
                if last_emit.elapsed() > Duration::from_millis(250) {
                    last_emit = Instant::now();
                    *self.download_progress.lock().unwrap() = (done_before + got, total);
                    let _ = self.app.emit("meeting-models-progress", self.models_status());
                }
            }
            file.flush()?;
            drop(file);
            if got != spec.size {
                let _ = std::fs::remove_file(&part);
                bail!("{} downloaded {} bytes, expected {}", spec.file, got, spec.size);
            }
            std::fs::rename(&part, &dest)?;
            done_before += got;
            *self.download_progress.lock().unwrap() = (done_before, total);
        }
        Ok(())
    }

    // ---- diarization ----------------------------------------------------------

    fn worker_path(&self) -> Result<PathBuf> {
        let path = self.app.path().resolve(
            "resources/nemo/handy-meeting-worker.exe",
            tauri::path::BaseDirectory::Resource,
        )?;
        if !path.exists() {
            bail!("Meeting worker not found at {}", path.display());
        }
        Ok(path)
    }

    pub fn current_job(&self) -> Option<DiarizationJob> {
        self.job.lock().unwrap().as_ref().map(|j| j.info.clone())
    }

    /// Start turning a history entry's recording into a meeting. Returns once
    /// the worker is running; progress, completion and failure arrive as the
    /// `meeting-diarize-progress`, `meeting-saved` and `meeting-diarize-failed`
    /// events.
    pub fn start_diarization(self: &Arc<Self>, entry: HistoryEntry) -> Result<()> {
        let mut job_guard = self.job.lock().unwrap();
        if job_guard.is_some() {
            bail!("Another recording is already being processed as a meeting");
        }
        if !MODELS.iter().all(|m| self.model_ready(m)) {
            bail!("models-missing");
        }
        let worker = self.worker_path()?;
        let recordings = self.recordings_dir();
        let source = recordings.join(&entry.file_name);
        if !source.exists() {
            bail!("The recording for this entry no longer exists");
        }
        let duration = wav_duration_secs(&source)?;

        // The meeting owns a copy of the audio so pruning the dictation
        // history can never take it away.
        let file_name = format!(
            "meeting-{}-{}.wav",
            entry.timestamp,
            chrono::Utc::now().timestamp()
        );
        let wav_path = recordings.join(&file_name);
        std::fs::copy(&source, &wav_path)
            .with_context(|| format!("copying {}", source.display()))?;

        let mut cmd = Command::new(&worker);
        cmd.arg("--asr-model")
            .arg(self.model_path(&ASR_MODEL))
            .arg("--diar-model")
            .arg(self.model_path(&DIAR_MODEL))
            .arg("--backend")
            .arg("vulkan")
            .arg("--diar-preset")
            .arg("offline")
            .arg("--wav")
            .arg(&wav_path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(&wav_path);
                return Err(e).context("starting the meeting worker");
            }
        };
        let stdout = child.stdout.take().context("worker stdout")?;
        let stderr = child.stderr.take().context("worker stderr")?;
        let child = Arc::new(Mutex::new(child));

        let info = DiarizationJob {
            history_id: entry.id,
            progress: 0.0,
            backend: None,
        };
        *job_guard = Some(RunningJob {
            info: info.clone(),
            child: child.clone(),
            cancelled: false,
        });
        drop(job_guard);
        let _ = self.app.emit("meeting-diarize-progress", info);
        info!(
            "Diarizing history entry #{} ({duration:.0}s) -> {file_name}",
            entry.id
        );

        // Worker diagnostics go to Handy's log.
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(|l| l.ok()) {
                debug!("[meeting-worker] {line}");
            }
        });

        let manager = self.clone();
        std::thread::spawn(move || {
            let started = Instant::now();
            let outcome = manager.read_worker_output(stdout, duration);
            {
                let mut child = child.lock().unwrap();
                let _ = child.kill();
                let _ = child.wait();
            }
            let cancelled = manager
                .job
                .lock()
                .unwrap()
                .take()
                .map(|j| j.cancelled)
                .unwrap_or(false);
            let result = match (cancelled, outcome) {
                (true, _) => Err(anyhow::anyhow!("cancelled")),
                (false, Ok(utterances)) => {
                    manager.save_meeting(&entry, &file_name, duration, utterances)
                }
                (false, Err(e)) => Err(e),
            };
            match result {
                Ok(meeting_id) => {
                    info!(
                        "Meeting #{meeting_id} saved from history entry #{} in {:.0}s",
                        entry.id,
                        started.elapsed().as_secs_f64()
                    );
                    let _ = manager.app.emit(
                        "meeting-saved",
                        MeetingSavedEvent {
                            history_id: entry.id,
                            meeting_id,
                        },
                    );
                }
                Err(e) => {
                    if cancelled {
                        info!("Diarization of history entry #{} cancelled", entry.id);
                    } else {
                        error!("Diarization of history entry #{} failed: {e:#}", entry.id);
                    }
                    let _ = std::fs::remove_file(&wav_path);
                    let _ = manager.app.emit(
                        "meeting-diarize-failed",
                        DiarizeFailedEvent {
                            history_id: entry.id,
                            message: format!("{e:#}"),
                            cancelled,
                        },
                    );
                }
            }
        });
        Ok(())
    }

    /// Stop the running diarization, if any. The job's own thread cleans up.
    pub fn cancel_diarization(&self) {
        if let Some(job) = self.job.lock().unwrap().as_mut() {
            job.cancelled = true;
            let _ = job.child.lock().unwrap().kill();
        }
    }

    /// Follow the worker's JSONL until it exits, forwarding progress, and
    /// return its final utterances.
    fn read_worker_output(
        &self,
        stdout: std::process::ChildStdout,
        duration: f64,
    ) -> Result<Vec<Utterance>> {
        let mut last_error = None;
        for line in BufReader::new(stdout).lines().map_while(|l| l.ok()) {
            let event: WorkerEvent = match serde_json::from_str(&line) {
                Ok(e) => e,
                Err(e) => {
                    debug!("Ignoring worker line ({e}): {line}");
                    continue;
                }
            };
            match event {
                WorkerEvent::Ready { backend } => {
                    info!("Meeting worker ready on {backend}");
                    self.update_job(|j| j.backend = Some(backend));
                }
                WorkerEvent::Update { asr_s, diar_s } => {
                    let progress = if duration > 0.0 {
                        (asr_s.min(diar_s) / duration).clamp(0.0, 0.99)
                    } else {
                        0.0
                    };
                    self.update_job(|j| j.progress = progress);
                }
                WorkerEvent::Final { utterances } => return Ok(utterances),
                WorkerEvent::Warning { message } => warn!("Meeting worker: {message}"),
                WorkerEvent::Error { message } => {
                    error!("Meeting worker error: {message}");
                    last_error = Some(message);
                }
            }
        }
        bail!(last_error.unwrap_or_else(|| "the meeting worker exited unexpectedly".to_string()))
    }

    fn update_job(&self, f: impl FnOnce(&mut DiarizationJob)) {
        let info = {
            let mut guard = self.job.lock().unwrap();
            let Some(job) = guard.as_mut() else { return };
            f(&mut job.info);
            job.info.clone()
        };
        let _ = self.app.emit("meeting-diarize-progress", info);
    }

    fn save_meeting(
        &self,
        entry: &HistoryEntry,
        file_name: &str,
        duration: f64,
        utterances: Vec<Utterance>,
    ) -> Result<i64> {
        let started_at = entry.timestamp;
        let title = base_title(started_at);
        let utterances: Vec<Utterance> = utterances
            .into_iter()
            .map(|mut u| {
                u.provisional = false;
                u
            })
            .collect();
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO meetings (started_at, ended_at, title, file_name, utterances_json, source_history_id, diarized_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                started_at,
                started_at + duration.round() as i64,
                title,
                file_name,
                serde_json::to_string(&utterances)?,
                entry.id,
                chrono::Utc::now().timestamp()
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }
}

fn has_column(conn: &Connection, column: &str) -> Result<bool> {
    Ok(conn
        .prepare("SELECT 1 FROM pragma_table_info('meetings') WHERE name = ?1")?
        .exists(params![column])?)
}

/// The fixed part of a meeting title: "Reunión 2026-10-09 18:06".
fn base_title(started_at: i64) -> String {
    chrono::DateTime::from_timestamp(started_at, 0)
        .map(|t| {
            t.with_timezone(&chrono::Local)
                .format("Reunión %Y-%m-%d %H:%M")
                .to_string()
        })
        .unwrap_or_else(|| "Reunión".to_string())
}

fn compose_title(started_at: i64, name: &str) -> String {
    let base = base_title(started_at);
    let name = name.trim();
    if name.is_empty() {
        base
    } else {
        format!("{base} - {name}")
    }
}

/// The user part of a title stored before names had their own column.
fn name_from_legacy_title(started_at: i64, title: &str) -> String {
    let base = base_title(started_at);
    let title = title.trim();
    if title == base {
        String::new()
    } else if let Some(rest) = title.strip_prefix(&format!("{base} - ")) {
        rest.trim().to_string()
    } else {
        title.to_string()
    }
}

fn audio_expires_at(diarized_at: Option<i64>, keep: bool, available: bool) -> Option<i64> {
    if keep || !available {
        return None;
    }
    diarized_at.map(|t| t + AUDIO_RETENTION_SECS)
}

fn wav_duration_secs(path: &Path) -> Result<f64> {
    let reader =
        hound::WavReader::open(path).with_context(|| format!("opening {}", path.display()))?;
    let spec = reader.spec();
    Ok(reader.duration() as f64 / spec.sample_rate as f64)
}

fn speaker_label(names: &HashMap<String, String>, speaker: i32) -> String {
    names
        .get(&speaker.to_string())
        .cloned()
        .unwrap_or_else(|| {
            if speaker > 0 {
                format!("Hablante {speaker}")
            } else {
                "Hablante ?".to_string()
            }
        })
}

fn format_ts(secs: f64) -> String {
    let s = secs.max(0.0) as u64;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, (s / 60) % 60, s % 60)
    } else {
        format!("{:02}:{:02}", s / 60, s % 60)
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum WorkerEvent {
    Ready {
        backend: String,
    },
    /// Live transcript updates are ignored here; only the progress counters
    /// matter for a finished recording.
    Update {
        #[serde(default)]
        asr_s: f64,
        #[serde(default)]
        diar_s: f64,
    },
    Final {
        utterances: Vec<Utterance>,
    },
    Warning {
        message: String,
    },
    Error {
        message: String,
    },
}

/// Convenience used by commands: an error message the UI can show.
pub fn err_string(e: anyhow::Error) -> String {
    format!("{e:#}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_worker_events() {
        let e: WorkerEvent = serde_json::from_str(
            r#"{"type":"update","committed":[{"speaker":2,"start":1.0,"end":2.0,"text":"hola","provisional":false}],"tail":[],"audio_s":3.0,"asr_s":2.5,"diar_s":2.9}"#,
        )
        .unwrap();
        match e {
            WorkerEvent::Update { asr_s, diar_s } => {
                assert_eq!(asr_s, 2.5);
                assert_eq!(diar_s, 2.9);
            }
            _ => panic!("expected update"),
        }
        let e: WorkerEvent =
            serde_json::from_str(r#"{"type":"ready","backend":"vulkan"}"#).unwrap();
        assert!(matches!(e, WorkerEvent::Ready { .. }));
        let e: WorkerEvent = serde_json::from_str(
            r#"{"type":"final","utterances":[{"speaker":1,"start":0.0,"end":1.0,"text":"hi"}],"audio_s":1.0}"#,
        )
        .unwrap();
        match e {
            WorkerEvent::Final { utterances } => assert_eq!(utterances[0].text, "hi"),
            _ => panic!("expected final"),
        }
    }

    #[test]
    fn labels_and_timestamps() {
        let mut names = HashMap::new();
        names.insert("2".to_string(), "Yuri".to_string());
        assert_eq!(speaker_label(&names, 2), "Yuri");
        assert_eq!(speaker_label(&names, 3), "Hablante 3");
        assert_eq!(format_ts(75.4), "01:15");
        assert_eq!(format_ts(3725.0), "1:02:05");
    }

    #[test]
    fn titles_keep_the_date_prefix() {
        let t = 1_760_000_000;
        let base = base_title(t);
        assert!(base.starts_with("Reunión 20"));
        assert_eq!(compose_title(t, "  "), base);
        assert_eq!(compose_title(t, " Diana "), format!("{base} - Diana"));
        assert_eq!(name_from_legacy_title(t, &base), "");
        assert_eq!(
            name_from_legacy_title(t, &format!("{base} - Diana")),
            "Diana"
        );
        assert_eq!(name_from_legacy_title(t, "Sprint review"), "Sprint review");
    }

    #[test]
    fn audio_expiry() {
        assert_eq!(
            audio_expires_at(Some(100), false, true),
            Some(100 + AUDIO_RETENTION_SECS)
        );
        assert_eq!(audio_expires_at(Some(100), true, true), None);
        assert_eq!(audio_expires_at(Some(100), false, false), None);
        assert_eq!(audio_expires_at(None, false, true), None);
    }
}
