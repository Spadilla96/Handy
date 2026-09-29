//! handy-meeting-worker: live transcription + speaker diarization for Handy's
//! meeting mode, run as a separate process so NeMo-Speech's ggml DLLs never
//! share an address space with Handy's own.
//!
//! Input (stdin): repeated `[u32 LE n][n x f32 LE]` blocks of 16 kHz mono
//! audio; `n = 0` or EOF ends the meeting. `--wav <file>` feeds a file instead
//! (for testing), optionally paced with `--realtime`.
//!
//! Output (stdout): one JSON object per line:
//!   {"type":"ready","backend":"vulkan"|"cpu"}
//!   {"type":"update","committed":[Utterance],"tail":[Utterance],"audio_s":..,"asr_s":..,"diar_s":..}
//!   {"type":"final","utterances":[Utterance],"audio_s":..}
//!   {"type":"error","message":".."}
//! Committed utterances never change; the tail is replaced on every update.

mod nemo_ffi;
mod transcript;

use std::io::{self, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde_json::json;

use nemo_ffi::{AsrWord, DiarSegment, Diarizer, Nemo, Recognizer};
use transcript::{build_utterances, Utterance};

const SAMPLE_RATE: i32 = 16_000;
/// Speaker labels (and interim words) newer than this may still be revised.
const PROVISIONAL_WINDOW_SECS: f64 = 10.0;
const UPDATE_INTERVAL: Duration = Duration::from_secs(1);
/// Re-query diarization segments after this much new audio.
const SEGMENT_REFRESH_SECS: f64 = 1.0;

struct Args {
    asr_model: PathBuf,
    diar_model: PathBuf,
    gpu: i32,
    wav: Option<PathBuf>,
    realtime: bool,
}

fn parse_args() -> Result<Args> {
    let mut asr_model = None;
    let mut diar_model = None;
    let mut gpu = 0;
    let mut wav = None;
    let mut realtime = false;
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--asr-model" => asr_model = it.next().map(PathBuf::from),
            "--diar-model" => diar_model = it.next().map(PathBuf::from),
            "--backend" => {
                gpu = match it.next().as_deref() {
                    Some("cpu") => -1,
                    Some("vulkan") | None => 0,
                    Some(other) => bail!("unknown backend {other}"),
                }
            }
            "--wav" => wav = it.next().map(PathBuf::from),
            "--realtime" => realtime = true,
            other => bail!("unknown argument {other}"),
        }
    }
    Ok(Args {
        asr_model: asr_model.context("--asr-model is required")?,
        diar_model: diar_model.context("--diar-model is required")?,
        gpu,
        wav,
        realtime,
    })
}

fn emit(value: serde_json::Value) {
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

#[derive(Clone)]
enum Msg {
    Audio(Arc<Vec<f32>>),
    End,
}

#[derive(Default)]
struct Shared {
    final_words: Vec<AsrWord>,
    interim_words: Vec<AsrWord>,
    segments: Vec<DiarSegment>,
    diar_frontier: f64,
    asr_audio: f64,
    audio_in: f64,
    asr_done: bool,
    diar_done: bool,
}

fn main() {
    if let Err(e) = run() {
        emit(json!({"type": "error", "message": format!("{e:#}")}));
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args = parse_args()?;
    let dir = std::env::current_exe()?
        .parent()
        .map(Path::to_path_buf)
        .context("no executable directory")?;
    let nemo = Nemo::load(&dir.join("nemo_speech_asr_c.dll"))?;

    let shared = Mutex::new(Shared::default());
    let (asr_tx, asr_rx) = mpsc::channel::<Msg>();
    let (diar_tx, diar_rx) = mpsc::channel::<Msg>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<i32>>();

    std::thread::scope(|s| -> Result<()> {
        // ASR thread: owns the recognizer and its stream.
        {
            let (nemo, shared, ready_tx, args) = (&nemo, &shared, ready_tx.clone(), &args);
            s.spawn(move || {
                let (mut rec, gpu) = match create_with_fallback(args.gpu, |g| {
                    Recognizer::new(nemo, &args.asr_model, g)
                }) {
                    Ok(v) => v,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e.context("loading the ASR model")));
                        return;
                    }
                };
                let _ = ready_tx.send(Ok(gpu));
                let result = asr_loop(&mut rec, asr_rx, shared);
                shared.lock().unwrap().asr_done = true;
                if let Err(e) = result {
                    emit(json!({"type": "error", "message": format!("ASR: {e:#}")}));
                }
            });
        }
        // Diarization thread: owns the Sortformer stream.
        {
            let (nemo, shared, ready_tx, args) = (&nemo, &shared, ready_tx.clone(), &args);
            s.spawn(move || {
                let (mut diar, gpu) = match create_with_fallback(args.gpu, |g| {
                    Diarizer::new(nemo, &args.diar_model, g)
                }) {
                    Ok(v) => v,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e.context("loading the diarization model")));
                        return;
                    }
                };
                let _ = ready_tx.send(Ok(gpu));
                let result = diar_loop(&mut diar, diar_rx, shared);
                shared.lock().unwrap().diar_done = true;
                if let Err(e) = result {
                    emit(json!({"type": "error", "message": format!("diarization: {e:#}")}));
                }
            });
        }
        drop(ready_tx);

        let mut backend = "vulkan";
        for _ in 0..2 {
            match ready_rx.recv().context("worker thread exited during start-up")? {
                Ok(gpu) if gpu < 0 => backend = "cpu",
                Ok(_) => {}
                Err(e) => {
                    // Unblock the other thread so the scope can end.
                    let _ = asr_tx.send(Msg::End);
                    let _ = diar_tx.send(Msg::End);
                    return Err(e);
                }
            }
        }
        emit(json!({"type": "ready", "backend": backend}));

        // Emitter thread: periodic incremental updates, then the final result.
        {
            let shared = &shared;
            s.spawn(move || emitter_loop(shared));
        }

        let feed = |samples: Vec<f32>| {
            let n = samples.len() as f64 / SAMPLE_RATE as f64;
            shared.lock().unwrap().audio_in += n;
            let block = Arc::new(samples);
            let _ = asr_tx.send(Msg::Audio(block.clone()));
            let _ = diar_tx.send(Msg::Audio(block));
        };
        let input = match &args.wav {
            Some(path) => feed_wav(path, args.realtime, feed),
            None => feed_stdin(feed),
        };
        let _ = asr_tx.send(Msg::End);
        let _ = diar_tx.send(Msg::End);
        input
    })?;
    Ok(())
}

/// Create a model on the requested device, retrying on the CPU when a GPU
/// backend is unavailable (e.g. no usable Vulkan driver).
fn create_with_fallback<T>(gpu: i32, create: impl Fn(i32) -> Result<T>) -> Result<(T, i32)> {
    match create(gpu) {
        Ok(v) => Ok((v, gpu)),
        Err(e) if gpu >= 0 => {
            emit(json!({"type": "warning", "message": format!("GPU init failed, using CPU: {e:#}")}));
            create(-1).map(|v| (v, -1))
        }
        Err(e) => Err(e),
    }
}

fn asr_loop(rec: &mut Recognizer, rx: mpsc::Receiver<Msg>, shared: &Mutex<Shared>) -> Result<()> {
    let mut pushed = 0.0;
    let drain = |rec: &mut Recognizer, pushed: f64| -> Result<()> {
        while let Some(res) = rec.next()? {
            let words: Vec<AsrWord> = res
                .words
                .into_iter()
                .filter(|w| !w.text.trim().is_empty())
                .collect();
            let mut st = shared.lock().unwrap();
            if res.is_final {
                st.final_words.extend(words);
                st.interim_words.clear();
            } else {
                st.interim_words = words;
            }
            st.asr_audio = pushed;
        }
        Ok(())
    };
    loop {
        match rx.recv() {
            Ok(Msg::Audio(block)) => {
                rec.push(&block, SAMPLE_RATE)?;
                pushed += block.len() as f64 / SAMPLE_RATE as f64;
                drain(rec, pushed)?;
                shared.lock().unwrap().asr_audio = pushed;
            }
            Ok(Msg::End) | Err(_) => break,
        }
    }
    rec.finish()?;
    drain(rec, pushed)?;
    // Anything still interim at the very end is as good as final.
    let mut st = shared.lock().unwrap();
    let rest = std::mem::take(&mut st.interim_words);
    st.final_words.extend(rest);
    Ok(())
}

fn diar_loop(diar: &mut Diarizer, rx: mpsc::Receiver<Msg>, shared: &Mutex<Shared>) -> Result<()> {
    let mut since_refresh = 0.0;
    let refresh = |diar: &Diarizer| -> Result<()> {
        let segments = diar.segments()?;
        let frontier = diar.frontier_seconds();
        let mut st = shared.lock().unwrap();
        st.segments = segments;
        st.diar_frontier = frontier;
        Ok(())
    };
    loop {
        match rx.recv() {
            Ok(Msg::Audio(block)) => {
                diar.push(&block, SAMPLE_RATE)?;
                since_refresh += block.len() as f64 / SAMPLE_RATE as f64;
                if since_refresh >= SEGMENT_REFRESH_SECS {
                    since_refresh = 0.0;
                    refresh(diar)?;
                }
            }
            Ok(Msg::End) | Err(_) => break,
        }
    }
    diar.finish()?;
    refresh(diar)
}

fn emitter_loop(shared: &Mutex<Shared>) {
    let mut committed_words = 0usize;
    loop {
        let started = Instant::now();
        let (done, update) = {
            let st = shared.lock().unwrap();
            let done = st.asr_done && st.diar_done;
            let stable_until = if done {
                f64::INFINITY
            } else {
                st.diar_frontier.min(st.asr_audio) - PROVISIONAL_WINDOW_SECS
            };
            if done {
                let all = build_utterances(&st.final_words, &[], &st.segments, stable_until);
                emit(json!({"type": "final", "utterances": all, "audio_s": st.audio_in}));
                (true, None)
            } else {
                let pending = &st.final_words[committed_words.min(st.final_words.len())..];
                let utterances =
                    build_utterances(pending, &st.interim_words, &st.segments, stable_until);
                // Commit closed, stable utterances from the front: a later
                // utterance must exist so this one can no longer grow.
                let mut n_commit = 0;
                while n_commit + 1 < utterances.len() && !utterances[n_commit].provisional {
                    n_commit += 1;
                }
                let committed: Vec<Utterance> = utterances[..n_commit].to_vec();
                committed_words += committed.iter().map(|u| u.word_count).sum::<usize>();
                let tail: Vec<Utterance> = utterances[n_commit..].to_vec();
                (
                    false,
                    Some(json!({
                        "type": "update",
                        "committed": committed,
                        "tail": tail,
                        "audio_s": st.audio_in,
                        "asr_s": st.asr_audio,
                        "diar_s": st.diar_frontier,
                    })),
                )
            }
        };
        if let Some(u) = update {
            emit(u);
        }
        if done {
            return;
        }
        std::thread::sleep(UPDATE_INTERVAL.saturating_sub(started.elapsed()));
    }
}

fn feed_stdin(mut feed: impl FnMut(Vec<f32>)) -> Result<()> {
    let mut input = BufReader::with_capacity(1 << 16, io::stdin().lock());
    let mut len = [0u8; 4];
    loop {
        match input.read_exact(&mut len) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(e) => return Err(e.into()),
        }
        let n = u32::from_le_bytes(len) as usize;
        if n == 0 {
            return Ok(());
        }
        let mut bytes = vec![0u8; n * 4];
        input.read_exact(&mut bytes)?;
        let samples = bytes
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        feed(samples);
    }
}

fn feed_wav(path: &Path, realtime: bool, mut feed: impl FnMut(Vec<f32>)) -> Result<()> {
    let mut reader = hound::WavReader::open(path)
        .with_context(|| format!("opening {}", path.display()))?;
    let spec = reader.spec();
    if spec.sample_rate != SAMPLE_RATE as u32 || spec.channels != 1 {
        bail!(
            "expected 16 kHz mono WAV, got {} Hz x {} ch",
            spec.sample_rate,
            spec.channels
        );
    }
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().collect::<Result<_, _>>()?,
        hound::SampleFormat::Int => {
            let scale = (1u64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 / scale))
                .collect::<Result<_, _>>()?
        }
    };
    let block = SAMPLE_RATE as usize / 10; // 100 ms
    let started = Instant::now();
    for (i, chunk) in samples.chunks(block).enumerate() {
        feed(chunk.to_vec());
        if realtime {
            let due = Duration::from_millis(100 * (i as u64 + 1));
            std::thread::sleep(due.saturating_sub(started.elapsed()));
        }
    }
    Ok(())
}
