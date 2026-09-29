//! Meeting mode: records microphone + system audio for a whole meeting and
//! streams it to `handy-meeting-worker` (a separate process running NeMo's
//! streaming ASR and Nemotron-3-Diarization), turning its JSONL output into a
//! live, speaker-attributed transcript that is saved when the meeting ends.
//!
//! The worker is out of process on purpose: NeMo ships its own `ggml*.dll`
//! builds, which would collide with the ones transcribe-cpp already loaded
//! into Handy.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use futures_util::StreamExt;
use log::{debug, error, info, warn};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, Manager};

use crate::managers::audio::AudioRecordingManager;
use crate::managers::history::HistoryManager;

const SAMPLE_RATE: u32 = 16_000;
/// How long `stop` waits for the worker to finish transcribing the backlog.
const FINAL_TIMEOUT: Duration = Duration::from_secs(20 * 60);

// ---- Audio tap --------------------------------------------------------------

/// Where the recorder's 16 kHz frames go while a meeting is active. Fed from
/// the recorder's consumer thread (not the real-time audio callback), so a
/// short uncontended lock is fine.
static AUDIO_SINK: Mutex<Option<mpsc::Sender<Vec<f32>>>> = Mutex::new(None);

/// Called for every captured frame; a no-op unless a meeting is recording.
pub fn feed_meeting_audio(frame: &[f32]) {
    if let Ok(guard) = AUDIO_SINK.lock() {
        if let Some(tx) = guard.as_ref() {
            let _ = tx.send(frame.to_vec());
        }
    }
}

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

#[derive(Clone, Debug, Serialize, Type)]
pub struct MeetingStatus {
    pub active: bool,
    /// Recording has stopped and the worker is finishing the transcript.
    pub finishing: bool,
    pub started_at: Option<i64>,
    pub auto_started: bool,
    pub committed: Vec<Utterance>,
    pub tail: Vec<Utterance>,
    /// Seconds of audio captured / transcribed so far.
    pub audio_s: f64,
    pub transcribed_s: f64,
    pub backend: Option<String>,
}

/// Incremental live update sent as the `meeting-transcript` event.
#[derive(Clone, Debug, Serialize, Type)]
pub struct MeetingTranscriptEvent {
    pub committed: Vec<Utterance>,
    pub tail: Vec<Utterance>,
    pub audio_s: f64,
    pub transcribed_s: f64,
}

#[derive(Clone, Debug, Serialize, Type)]
pub struct MeetingSummary {
    pub id: i64,
    pub started_at: i64,
    pub ended_at: i64,
    pub title: String,
    pub speaker_count: u32,
    pub preview: String,
}

#[derive(Clone, Debug, Serialize, Type)]
pub struct Meeting {
    pub id: i64,
    pub started_at: i64,
    pub ended_at: i64,
    pub title: String,
    pub file_name: String,
    pub utterances: Vec<Utterance>,
    /// Speaker id (as a string) -> display name.
    pub speaker_names: HashMap<String, String>,
}

// ---- Live session -------------------------------------------------------------

struct Live {
    started_at: i64,
    started_instant: Instant,
    auto_started: bool,
    file_name: String,
    committed: Vec<Utterance>,
    tail: Vec<Utterance>,
    audio_s: f64,
    transcribed_s: f64,
    backend: Option<String>,
    finishing: bool,
}

struct Session {
    live: Arc<Mutex<Live>>,
    child: Child,
    final_rx: mpsc::Receiver<Option<Vec<Utterance>>>,
    writer: std::thread::JoinHandle<()>,
}

pub struct MeetingManager {
    app: AppHandle,
    db_path: PathBuf,
    models_dir: PathBuf,
    session: Mutex<Option<Session>>,
    /// Snapshot of the live transcript, readable while `session` is busy.
    live: Mutex<Option<Arc<Mutex<Live>>>>,
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
            session: Mutex::new(None),
            live: Mutex::new(None),
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
        self.conn()?.execute_batch(
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
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<MeetingSummary>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, started_at, ended_at, title, utterances_json FROM meetings ORDER BY started_at DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, started_at, ended_at, title, json) = row?;
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
                title,
                speaker_count: speakers.len() as u32,
                preview,
            });
        }
        Ok(out)
    }

    pub fn get(&self, id: i64) -> Result<Meeting> {
        let conn = self.conn()?;
        let (started_at, ended_at, title, file_name, utt, names): (
            i64,
            i64,
            String,
            String,
            String,
            String,
        ) = conn.query_row(
            "SELECT started_at, ended_at, title, file_name, utterances_json, speaker_names_json FROM meetings WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )?;
        Ok(Meeting {
            id,
            started_at,
            ended_at,
            title,
            file_name,
            utterances: serde_json::from_str(&utt).unwrap_or_default(),
            speaker_names: serde_json::from_str(&names).unwrap_or_default(),
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

    pub fn rename(&self, id: i64, title: &str) -> Result<()> {
        self.conn()?.execute(
            "UPDATE meetings SET title = ?1 WHERE id = ?2",
            params![title.trim(), id],
        )?;
        Ok(())
    }

    pub fn delete(&self, id: i64) -> Result<()> {
        let meeting = self.get(id)?;
        self.conn()?
            .execute("DELETE FROM meetings WHERE id = ?1", params![id])?;
        let path = self.recordings_dir().join(&meeting.file_name);
        if path.exists() {
            let _ = std::fs::remove_file(path);
        }
        Ok(())
    }

    pub fn audio_path(&self, id: i64) -> Result<PathBuf> {
        Ok(self.recordings_dir().join(self.get(id)?.file_name))
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

    // ---- live session -------------------------------------------------------

    pub fn is_active(&self) -> bool {
        self.live.lock().unwrap().is_some()
    }

    pub fn is_auto_started(&self) -> bool {
        self.live
            .lock()
            .unwrap()
            .as_ref()
            .map(|l| l.lock().unwrap().auto_started)
            .unwrap_or(false)
    }

    pub fn status(&self) -> MeetingStatus {
        match self.live.lock().unwrap().as_ref() {
            Some(live) => {
                let l = live.lock().unwrap();
                MeetingStatus {
                    active: true,
                    finishing: l.finishing,
                    started_at: Some(l.started_at),
                    auto_started: l.auto_started,
                    committed: l.committed.clone(),
                    tail: l.tail.clone(),
                    audio_s: l.audio_s,
                    transcribed_s: l.transcribed_s,
                    backend: l.backend.clone(),
                }
            }
            None => MeetingStatus {
                active: false,
                finishing: false,
                started_at: None,
                auto_started: false,
                committed: Vec::new(),
                tail: Vec::new(),
                audio_s: 0.0,
                transcribed_s: 0.0,
                backend: None,
            },
        }
    }

    fn emit_state(&self) {
        let _ = self.app.emit("meeting-state", self.status());
    }

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

    /// Start recording a meeting. `auto_started` marks sessions begun from the
    /// Teams detector, which may also stop them automatically.
    pub fn start(&self, auto_started: bool) -> Result<()> {
        let mut session_guard = self.session.lock().unwrap();
        if session_guard.is_some() {
            bail!("A meeting is already being recorded");
        }
        if !MODELS.iter().all(|m| self.model_ready(m)) {
            bail!("models-missing");
        }
        let worker = self.worker_path()?;
        let started_at = chrono::Utc::now().timestamp();
        let file_name = format!("meeting-{started_at}.wav");
        let wav_path = self.recordings_dir().join(&file_name);

        let mut cmd = Command::new(&worker);
        cmd.arg("--asr-model")
            .arg(self.model_path(&ASR_MODEL))
            .arg("--diar-model")
            .arg(self.model_path(&DIAR_MODEL))
            .arg("--backend")
            .arg("vulkan")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().context("starting the meeting worker")?;
        let stdin = child.stdin.take().context("worker stdin")?;
        let stdout = child.stdout.take().context("worker stdout")?;
        let stderr = child.stderr.take().context("worker stderr")?;

        let live = Arc::new(Mutex::new(Live {
            started_at,
            started_instant: Instant::now(),
            auto_started,
            file_name: file_name.clone(),
            committed: Vec::new(),
            tail: Vec::new(),
            audio_s: 0.0,
            transcribed_s: 0.0,
            backend: None,
            finishing: false,
        }));

        // Worker diagnostics go to Handy's log.
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(|l| l.ok()) {
                debug!("[meeting-worker] {line}");
            }
        });

        // Worker events -> live state + frontend events.
        let (final_tx, final_rx) = mpsc::channel();
        {
            let (live, app) = (live.clone(), self.app.clone());
            std::thread::spawn(move || read_worker_output(stdout, live, app, final_tx));
        }

        // Captured audio -> WAV file + worker stdin.
        let (audio_tx, audio_rx) = mpsc::channel::<Vec<f32>>();
        let writer = {
            let live = live.clone();
            std::thread::spawn(move || {
                if let Err(e) = write_audio(audio_rx, stdin, &wav_path, &live) {
                    error!("Meeting audio writer failed: {e:#}");
                }
            })
        };
        *AUDIO_SINK.lock().unwrap() = Some(audio_tx);

        let rm = self.app.state::<Arc<AudioRecordingManager>>();
        if let Err(e) = rm.try_start_meeting() {
            *AUDIO_SINK.lock().unwrap() = None;
            let _ = child.kill();
            let _ = writer.join();
            bail!("{e}");
        }

        *self.live.lock().unwrap() = Some(live.clone());
        *session_guard = Some(Session {
            live,
            child,
            final_rx,
            writer,
        });
        drop(session_guard);
        info!("Meeting recording started (auto={auto_started}) -> {file_name}");
        self.emit_state();
        Ok(())
    }

    /// Stop recording, wait for the worker to finish the transcript, save it
    /// and return the new meeting id. Blocks; call from a worker thread.
    pub fn stop(&self) -> Result<i64> {
        let Some(mut session) = self.session.lock().unwrap().take() else {
            bail!("No meeting is being recorded");
        };
        let rm = self.app.state::<Arc<AudioRecordingManager>>();
        rm.stop_meeting();
        // Dropping the sender ends the writer thread, which closes the
        // worker's stdin; the worker then flushes and emits its final result.
        *AUDIO_SINK.lock().unwrap() = None;
        let _ = session.writer.join();
        session.live.lock().unwrap().finishing = true;
        self.emit_state();

        let final_utterances = match session.final_rx.recv_timeout(FINAL_TIMEOUT) {
            Ok(Some(u)) => u,
            Ok(None) | Err(_) => {
                warn!("Meeting worker ended without a final transcript; saving the live one");
                let l = session.live.lock().unwrap();
                l.committed.iter().chain(l.tail.iter()).cloned().collect()
            }
        };
        let _ = session.child.kill();
        let _ = session.child.wait();

        let (started_at, file_name, duration) = {
            let l = session.live.lock().unwrap();
            (
                l.started_at,
                l.file_name.clone(),
                l.started_instant.elapsed().as_secs() as i64,
            )
        };
        let title = chrono::DateTime::from_timestamp(started_at, 0)
            .map(|t| {
                t.with_timezone(&chrono::Local)
                    .format("Reunión %Y-%m-%d %H:%M")
                    .to_string()
            })
            .unwrap_or_else(|| "Reunión".to_string());
        let utterances: Vec<Utterance> = final_utterances
            .into_iter()
            .map(|mut u| {
                u.provisional = false;
                u
            })
            .collect();
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO meetings (started_at, ended_at, title, file_name, utterances_json) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                started_at,
                started_at + duration,
                title,
                file_name,
                serde_json::to_string(&utterances)?
            ],
        )?;
        let id = conn.last_insert_rowid();
        *self.live.lock().unwrap() = None;
        info!(
            "Meeting saved as #{id} ({} utterances, {}s)",
            utterances.len(),
            duration
        );
        self.emit_state();
        let _ = self.app.emit("meeting-saved", id);
        Ok(id)
    }
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

/// Forward frames to the worker (length-prefixed f32 blocks) and append them
/// to the meeting WAV. Ends, closing the worker's stdin, when the sender side
/// is dropped by `stop`.
fn write_audio(
    rx: mpsc::Receiver<Vec<f32>>,
    stdin: std::process::ChildStdin,
    wav_path: &Path,
    live: &Mutex<Live>,
) -> Result<()> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut wav = hound::WavWriter::create(wav_path, spec)
        .with_context(|| format!("creating {}", wav_path.display()))?;
    let mut out = BufWriter::new(stdin);
    let mut worker_alive = true;
    let mut samples_total = 0u64;
    while let Ok(frame) = rx.recv() {
        for &s in &frame {
            wav.write_sample((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)?;
        }
        samples_total += frame.len() as u64;
        if worker_alive {
            let mut block = Vec::with_capacity(4 + frame.len() * 4);
            block.extend_from_slice(&(frame.len() as u32).to_le_bytes());
            for s in &frame {
                block.extend_from_slice(&s.to_le_bytes());
            }
            if out.write_all(&block).and_then(|_| out.flush()).is_err() {
                // Keep saving the audio even if the worker died.
                warn!("Meeting worker stopped accepting audio");
                worker_alive = false;
            }
        }
        live.lock().unwrap().audio_s = samples_total as f64 / SAMPLE_RATE as f64;
    }
    if worker_alive {
        let _ = out.write_all(&0u32.to_le_bytes());
        let _ = out.flush();
    }
    drop(out);
    wav.finalize()?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum WorkerEvent {
    Ready {
        backend: String,
    },
    Update {
        committed: Vec<Utterance>,
        tail: Vec<Utterance>,
        #[serde(default)]
        asr_s: f64,
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

fn read_worker_output(
    stdout: std::process::ChildStdout,
    live: Arc<Mutex<Live>>,
    app: AppHandle,
    final_tx: mpsc::Sender<Option<Vec<Utterance>>>,
) {
    let mut got_final = false;
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
                live.lock().unwrap().backend = Some(backend);
                let _ = app.emit("meeting-state", ());
            }
            WorkerEvent::Update {
                committed,
                tail,
                asr_s,
            } => {
                let event = {
                    let mut l = live.lock().unwrap();
                    l.committed.extend(committed.iter().cloned());
                    l.tail = tail.clone();
                    l.transcribed_s = asr_s;
                    MeetingTranscriptEvent {
                        committed,
                        tail,
                        audio_s: l.audio_s,
                        transcribed_s: asr_s,
                    }
                };
                let _ = app.emit("meeting-transcript", event);
            }
            WorkerEvent::Final { utterances } => {
                got_final = true;
                let _ = final_tx.send(Some(utterances));
            }
            WorkerEvent::Warning { message } => warn!("Meeting worker: {message}"),
            WorkerEvent::Error { message } => {
                error!("Meeting worker error: {message}");
                let _ = app.emit("meeting-error", message);
            }
        }
    }
    if !got_final {
        let _ = final_tx.send(None);
    }
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
            WorkerEvent::Update { committed, asr_s, .. } => {
                assert_eq!(committed[0].speaker, 2);
                assert_eq!(asr_s, 2.5);
            }
            _ => panic!("expected update"),
        }
        let e: WorkerEvent =
            serde_json::from_str(r#"{"type":"ready","backend":"vulkan"}"#).unwrap();
        assert!(matches!(e, WorkerEvent::Ready { .. }));
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
}
