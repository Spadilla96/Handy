//! Minimal dynamic bindings to NeMo-Speech.cpp's stable C ABI
//! (`include/nemo_speech/asr.h` and `diar.h`), loaded at runtime from
//! `nemo_speech_asr_c.dll` next to this executable.
//!
//! Only the calls the meeting worker needs are bound. Structs mirror the C
//! headers field for field; every config struct starts with `size`, which must
//! be set to its `size_of` so the library can default any fields it knows about
//! that we don't.

use std::ffi::{c_char, c_void, CStr, CString};
use std::path::Path;
use std::ptr;

use anyhow::{anyhow, bail, Context, Result};
use libloading::{Library, Symbol};

pub type Status = i32;
pub const STATUS_OK: Status = 0;

// ---- diar.h -------------------------------------------------------------

#[repr(C)]
pub struct DiarModelConfig {
    pub size: usize,
    pub model_path: *const c_char,
    pub gpu: i32,
    pub preset: *const c_char,
    pub chunk_frames: i32,
    pub right_context_frames: i32,
    pub left_context_frames: i32,
    pub fifo_frames: i32,
    pub spkcache_frames: i32,
    pub update_period_frames: i32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct DiarSegment {
    pub start_time: f64,
    pub end_time: f64,
    pub speaker: i32,
}

// ---- asr.h --------------------------------------------------------------

#[repr(C)]
pub struct BackendConfig {
    pub size: usize,
    pub gpu: i32,
}

#[repr(C)]
pub struct ModelConfig {
    pub size: usize,
    pub path: *const c_char,
    pub name: *const c_char,
}

#[repr(C)]
pub struct EndpointingConfig {
    pub size: usize,
    pub enable: bool,
    pub vad_based: bool,
    pub stop_history_eou_ms: i32,
}

#[repr(C)]
pub struct RecognizerConfig {
    pub size: usize,
    pub backend: *const BackendConfig,
    pub model: *const ModelConfig,
    pub streaming: *const c_void,
    pub decoder: *const c_void,
    pub vad: *const c_void,
    pub endpointing: *const c_void,
    pub postproc: *const c_void,
    pub diar: *const c_void,
    pub batching: *const c_void,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct RecognitionOptions {
    pub size: usize,
    pub request_id: *const c_char,
    pub language_code: *const c_char,
    pub interim_results: bool,
    pub enable_word_time_offsets: bool,
    pub enable_automatic_punctuation: bool,
    pub verbatim_transcripts: bool,
    pub profanity_filter: bool,
    pub stop_history_eou_ms: i32,
    pub speech_contexts: *const c_void,
    pub speech_context_count: usize,
    pub max_alternatives: i32,
    pub enable_speaker_diarization: bool,
    pub max_speaker_count: i32,
}

type Opaque = c_void;

/// Function table resolved from the DLL. The `Library` is kept alive for as
/// long as any of these pointers may be called.
pub struct Nemo {
    _lib: Library,
    last_error: unsafe extern "C" fn() -> *const c_char,

    diar_create: unsafe extern "C" fn(*const DiarModelConfig, *mut *mut Opaque) -> Status,
    diar_destroy: unsafe extern "C" fn(*mut Opaque),
    diar_seconds_per_frame: unsafe extern "C" fn(*const Opaque) -> f64,
    diar_stream_open: unsafe extern "C" fn(*mut Opaque, *mut *mut Opaque) -> Status,
    diar_stream_push_f32: unsafe extern "C" fn(*mut Opaque, *const f32, usize, i32) -> Status,
    diar_stream_finish: unsafe extern "C" fn(*mut Opaque) -> Status,
    diar_stream_close: unsafe extern "C" fn(*mut Opaque),
    diar_frame_count: unsafe extern "C" fn(*const Opaque) -> i64,
    diar_segments: unsafe extern "C" fn(
        *const Opaque,
        *const c_void,
        *mut DiarSegment,
        usize,
        *mut usize,
    ) -> Status,

    asr_options_default: unsafe extern "C" fn() -> RecognitionOptions,
    asr_create: unsafe extern "C" fn(*const RecognizerConfig, *mut *mut Opaque) -> Status,
    asr_destroy: unsafe extern "C" fn(*mut Opaque),
    asr_streaming_recognize:
        unsafe extern "C" fn(*mut Opaque, *const RecognitionOptions, *mut *mut Opaque) -> Status,
    asr_stream_push_f32: unsafe extern "C" fn(*mut Opaque, *const f32, usize, i32) -> Status,
    asr_stream_finish: unsafe extern "C" fn(*mut Opaque) -> Status,
    asr_stream_next: unsafe extern "C" fn(*mut Opaque, *mut *mut Opaque) -> Status,
    asr_stream_close: unsafe extern "C" fn(*mut Opaque),
    result_is_final: unsafe extern "C" fn(*const Opaque) -> bool,
    result_word_count: unsafe extern "C" fn(*const Opaque, usize) -> usize,
    result_word_text: unsafe extern "C" fn(*const Opaque, usize, usize) -> *const c_char,
    result_word_start_time: unsafe extern "C" fn(*const Opaque, usize, usize) -> i32,
    result_word_end_time: unsafe extern "C" fn(*const Opaque, usize, usize) -> i32,
    result_destroy: unsafe extern "C" fn(*mut Opaque),
}

// The function pointers are plain C entry points; the library documents its
// streams as single-threaded, which callers uphold by owning each stream on
// one thread.
unsafe impl Send for Nemo {}
unsafe impl Sync for Nemo {}

macro_rules! sym {
    ($lib:expr, $name:literal) => {{
        let s: Symbol<_> = unsafe { $lib.get(concat!($name, "\0").as_bytes()) }
            .with_context(|| format!("missing symbol {}", $name))?;
        *s
    }};
}

impl Nemo {
    pub fn load(dll: &Path) -> Result<Self> {
        let lib = unsafe { Library::new(dll) }
            .with_context(|| format!("failed to load {}", dll.display()))?;
        Ok(Self {
            last_error: sym!(lib, "nemo_speech_asr_last_error"),
            diar_create: sym!(lib, "nemo_speech_diar_create"),
            diar_destroy: sym!(lib, "nemo_speech_diar_destroy"),
            diar_seconds_per_frame: sym!(lib, "nemo_speech_diar_seconds_per_frame"),
            diar_stream_open: sym!(lib, "nemo_speech_diar_stream_open"),
            diar_stream_push_f32: sym!(lib, "nemo_speech_diar_stream_push_f32"),
            diar_stream_finish: sym!(lib, "nemo_speech_diar_stream_finish"),
            diar_stream_close: sym!(lib, "nemo_speech_diar_stream_close"),
            diar_frame_count: sym!(lib, "nemo_speech_diar_frame_count"),
            diar_segments: sym!(lib, "nemo_speech_diar_segments"),
            asr_options_default: sym!(lib, "nemo_speech_asr_recognition_options_default"),
            asr_create: sym!(lib, "nemo_speech_asr_create"),
            asr_destroy: sym!(lib, "nemo_speech_asr_destroy"),
            asr_streaming_recognize: sym!(lib, "nemo_speech_asr_streaming_recognize"),
            asr_stream_push_f32: sym!(lib, "nemo_speech_asr_stream_push_f32"),
            asr_stream_finish: sym!(lib, "nemo_speech_asr_stream_finish"),
            asr_stream_next: sym!(lib, "nemo_speech_asr_stream_next"),
            asr_stream_close: sym!(lib, "nemo_speech_asr_stream_close"),
            result_is_final: sym!(lib, "nemo_speech_asr_result_is_final"),
            result_word_count: sym!(lib, "nemo_speech_asr_result_word_count"),
            result_word_text: sym!(lib, "nemo_speech_asr_result_word_text"),
            result_word_start_time: sym!(lib, "nemo_speech_asr_result_word_start_time"),
            result_word_end_time: sym!(lib, "nemo_speech_asr_result_word_end_time"),
            result_destroy: sym!(lib, "nemo_speech_asr_result_destroy"),
            _lib: lib,
        })
    }

    fn check(&self, status: Status, what: &str) -> Result<()> {
        if status == STATUS_OK {
            return Ok(());
        }
        let msg = unsafe {
            let p = (self.last_error)();
            if p.is_null() {
                String::new()
            } else {
                CStr::from_ptr(p).to_string_lossy().into_owned()
            }
        };
        bail!("{what} failed (status {status}): {msg}")
    }
}

fn cstring(path: &Path) -> Result<CString> {
    CString::new(path.to_string_lossy().as_bytes()).map_err(|_| anyhow!("path contains NUL"))
}

// ---- Diarizer -------------------------------------------------------------

pub struct Diarizer<'a> {
    nemo: &'a Nemo,
    model: *mut Opaque,
    stream: *mut Opaque,
    seconds_per_frame: f64,
}

impl<'a> Diarizer<'a> {
    pub fn new(nemo: &'a Nemo, model_path: &Path, gpu: i32) -> Result<Self> {
        let path = cstring(model_path)?;
        let cfg = DiarModelConfig {
            size: std::mem::size_of::<DiarModelConfig>(),
            model_path: path.as_ptr(),
            gpu,
            preset: ptr::null(),
            chunk_frames: 0,
            right_context_frames: 0,
            left_context_frames: -1,
            fifo_frames: 0,
            spkcache_frames: 0,
            update_period_frames: 0,
        };
        let mut model = ptr::null_mut();
        nemo.check(
            unsafe { (nemo.diar_create)(&cfg, &mut model) },
            "diar_create",
        )?;
        let mut stream = ptr::null_mut();
        if let Err(e) = nemo.check(
            unsafe { (nemo.diar_stream_open)(model, &mut stream) },
            "diar_stream_open",
        ) {
            unsafe { (nemo.diar_destroy)(model) };
            return Err(e);
        }
        let seconds_per_frame = unsafe { (nemo.diar_seconds_per_frame)(model) };
        Ok(Self {
            nemo,
            model,
            stream,
            seconds_per_frame,
        })
    }

    pub fn push(&mut self, samples: &[f32], sample_rate: i32) -> Result<()> {
        self.nemo.check(
            unsafe {
                (self.nemo.diar_stream_push_f32)(
                    self.stream,
                    samples.as_ptr(),
                    samples.len(),
                    sample_rate,
                )
            },
            "diar_stream_push_f32",
        )
    }

    pub fn finish(&mut self) -> Result<()> {
        self.nemo.check(
            unsafe { (self.nemo.diar_stream_finish)(self.stream) },
            "diar_stream_finish",
        )
    }

    /// Seconds of audio labeled so far.
    pub fn frontier_seconds(&self) -> f64 {
        unsafe { (self.nemo.diar_frame_count)(self.stream) as f64 * self.seconds_per_frame }
    }

    pub fn segments(&self) -> Result<Vec<DiarSegment>> {
        let mut count = 0usize;
        self.nemo.check(
            unsafe {
                (self.nemo.diar_segments)(self.stream, ptr::null(), ptr::null_mut(), 0, &mut count)
            },
            "diar_segments(count)",
        )?;
        let mut out = vec![DiarSegment::default(); count];
        if count > 0 {
            self.nemo.check(
                unsafe {
                    (self.nemo.diar_segments)(
                        self.stream,
                        ptr::null(),
                        out.as_mut_ptr(),
                        out.len(),
                        &mut count,
                    )
                },
                "diar_segments",
            )?;
            out.truncate(count);
        }
        Ok(out)
    }
}

impl Drop for Diarizer<'_> {
    fn drop(&mut self) {
        unsafe {
            (self.nemo.diar_stream_close)(self.stream);
            (self.nemo.diar_destroy)(self.model);
        }
    }
}

// ---- Recognizer -----------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct AsrWord {
    pub text: String,
    /// Seconds from the start of the stream.
    pub start: f64,
    pub end: f64,
}

pub struct AsrResult {
    pub is_final: bool,
    pub words: Vec<AsrWord>,
}

pub struct Recognizer<'a> {
    nemo: &'a Nemo,
    recognizer: *mut Opaque,
    stream: *mut Opaque,
}

impl<'a> Recognizer<'a> {
    /// `endpoint_ms` > 0 enables silence endpointing so finalized words arrive
    /// during the stream instead of only at `finish`.
    pub fn new(nemo: &'a Nemo, model_path: &Path, gpu: i32, endpoint_ms: i32) -> Result<Self> {
        let path = cstring(model_path)?;
        let endpointing = EndpointingConfig {
            size: std::mem::size_of::<EndpointingConfig>(),
            enable: endpoint_ms > 0,
            vad_based: false,
            stop_history_eou_ms: endpoint_ms.max(0),
        };
        let backend = BackendConfig {
            size: std::mem::size_of::<BackendConfig>(),
            gpu,
        };
        let model = ModelConfig {
            size: std::mem::size_of::<ModelConfig>(),
            path: path.as_ptr(),
            name: ptr::null(),
        };
        let cfg = RecognizerConfig {
            size: std::mem::size_of::<RecognizerConfig>(),
            backend: &backend,
            model: &model,
            streaming: ptr::null(),
            decoder: ptr::null(),
            vad: ptr::null(),
            endpointing: &endpointing as *const EndpointingConfig as *const c_void,
            postproc: ptr::null(),
            diar: ptr::null(),
            batching: ptr::null(),
        };
        let mut recognizer = ptr::null_mut();
        nemo.check(
            unsafe { (nemo.asr_create)(&cfg, &mut recognizer) },
            "asr_create",
        )?;

        let mut opts = unsafe { (nemo.asr_options_default)() };
        opts.interim_results = true;
        opts.enable_word_time_offsets = true;
        let mut stream = ptr::null_mut();
        if let Err(e) = nemo.check(
            unsafe { (nemo.asr_streaming_recognize)(recognizer, &opts, &mut stream) },
            "asr_streaming_recognize",
        ) {
            unsafe { (nemo.asr_destroy)(recognizer) };
            return Err(e);
        }
        Ok(Self {
            nemo,
            recognizer,
            stream,
        })
    }

    pub fn push(&mut self, samples: &[f32], sample_rate: i32) -> Result<()> {
        self.nemo.check(
            unsafe {
                (self.nemo.asr_stream_push_f32)(
                    self.stream,
                    samples.as_ptr(),
                    samples.len(),
                    sample_rate,
                )
            },
            "asr_stream_push_f32",
        )
    }

    pub fn finish(&mut self) -> Result<()> {
        self.nemo.check(
            unsafe { (self.nemo.asr_stream_finish)(self.stream) },
            "asr_stream_finish",
        )
    }

    /// Decode and pull one result, or `None` when more audio is needed.
    pub fn next(&mut self) -> Result<Option<AsrResult>> {
        let mut res = ptr::null_mut();
        self.nemo.check(
            unsafe { (self.nemo.asr_stream_next)(self.stream, &mut res) },
            "asr_stream_next",
        )?;
        if res.is_null() {
            return Ok(None);
        }
        let n = self.nemo;
        let out = unsafe {
            let count = (n.result_word_count)(res, 0);
            let mut words = Vec::with_capacity(count);
            for i in 0..count {
                let p = (n.result_word_text)(res, 0, i);
                let text = if p.is_null() {
                    String::new()
                } else {
                    CStr::from_ptr(p).to_string_lossy().into_owned()
                };
                // Word offsets are reported in milliseconds (Riva convention).
                words.push(AsrWord {
                    text,
                    start: (n.result_word_start_time)(res, 0, i) as f64 / 1000.0,
                    end: (n.result_word_end_time)(res, 0, i) as f64 / 1000.0,
                });
            }
            let is_final = (n.result_is_final)(res);
            (n.result_destroy)(res);
            AsrResult { is_final, words }
        };
        Ok(Some(out))
    }
}

impl Drop for Recognizer<'_> {
    fn drop(&mut self) {
        unsafe {
            (self.nemo.asr_stream_close)(self.stream);
            (self.nemo.asr_destroy)(self.recognizer);
        }
    }
}
