//! Combine timed ASR words (Whisper, run inside Handy) with the diarizer's
//! speaker segments (from `handy-meeting-worker`) into speaker-attributed
//! utterances. Same rules as the worker's own merge (`meeting-worker/src/
//! transcript.rs`); kept free of I/O so it can be unit tested.

use serde::Deserialize;

use crate::managers::meeting::Utterance;

/// Silence longer than this between two words of the same speaker starts a
/// new utterance.
const MAX_GAP_SECS: f64 = 2.5;
/// A word with no overlapping segment adopts the nearest one within this
/// distance; otherwise it keeps the previous word's speaker.
const MAX_NEAREST_SECS: f64 = 3.0;

/// A transcribed word, in seconds from the start of the recording.
#[derive(Clone, Debug, PartialEq)]
pub struct TimedWord {
    pub text: String,
    pub start: f64,
    pub end: f64,
}

/// One diarizer segment, in seconds; `speaker` is 1-based.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub struct SpeakerSegment {
    pub start: f64,
    pub end: f64,
    pub speaker: i32,
}

/// Speaker for the span `[start, end]`: largest overlap wins (ties go to the
/// shorter, more specific segment); with no overlap, the nearest segment if
/// close enough.
pub fn speaker_for(segments: &[SpeakerSegment], start: f64, end: f64) -> Option<i32> {
    let mut best: Option<(&SpeakerSegment, f64)> = None;
    for seg in segments {
        let overlap = end.min(seg.end) - start.max(seg.start);
        if overlap <= 0.0 {
            continue;
        }
        let better = match best {
            None => true,
            Some((b, bo)) => {
                overlap > bo || (overlap == bo && (seg.end - seg.start) < (b.end - b.start))
            }
        };
        if better {
            best = Some((seg, overlap));
        }
    }
    if let Some((seg, _)) = best {
        return Some(seg.speaker);
    }

    let mid = (start + end) / 2.0;
    segments
        .iter()
        .map(|s| {
            let d = if mid < s.start {
                s.start - mid
            } else {
                mid - s.end
            };
            (s, d.max(0.0))
        })
        .filter(|(_, d)| *d <= MAX_NEAREST_SECS)
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(s, _)| s.speaker)
}

/// Attribute every word to a speaker and group consecutive same-speaker words
/// into utterances.
pub fn build_utterances(words: &[TimedWord], segments: &[SpeakerSegment]) -> Vec<Utterance> {
    let mut out: Vec<Utterance> = Vec::new();
    let mut last_speaker = 0;
    for word in words {
        let text = word.text.trim();
        if text.is_empty() {
            continue;
        }
        let speaker = speaker_for(segments, word.start, word.end).unwrap_or(last_speaker);
        last_speaker = speaker;
        match out.last_mut() {
            Some(u) if u.speaker == speaker && word.start - u.end <= MAX_GAP_SECS => {
                u.text.push(' ');
                u.text.push_str(text);
                u.end = u.end.max(word.end);
            }
            _ => out.push(Utterance {
                speaker,
                start: word.start,
                end: word.end,
                text: text.to_string(),
                provisional: false,
            }),
        }
    }
    out
}

/// Split a timed segment's text into words, spreading `[start, end]` over
/// them in proportion to their length. Used when the model only reports
/// segment-level timestamps.
pub fn interpolate_words(text: &str, start: f64, end: f64) -> Vec<TimedWord> {
    let parts: Vec<&str> = text.split_whitespace().collect();
    let total: usize = parts.iter().map(|p| p.chars().count()).sum();
    if parts.is_empty() || total == 0 {
        return Vec::new();
    }
    let span = (end - start).max(0.0);
    let mut out = Vec::with_capacity(parts.len());
    let mut done = 0usize;
    for part in parts {
        let len = part.chars().count();
        let w_start = start + span * done as f64 / total as f64;
        done += len;
        let w_end = start + span * done as f64 / total as f64;
        out.push(TimedWord {
            text: part.to_string(),
            start: w_start,
            end: w_end,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(text: &str, start: f64, end: f64) -> TimedWord {
        TimedWord {
            text: text.into(),
            start,
            end,
        }
    }

    fn seg(start: f64, end: f64, speaker: i32) -> SpeakerSegment {
        SpeakerSegment {
            start,
            end,
            speaker,
        }
    }

    #[test]
    fn largest_overlap_wins_and_nearest_fills_gaps() {
        let segs = [seg(0.0, 2.0, 1), seg(1.8, 4.0, 2)];
        assert_eq!(speaker_for(&segs, 1.7, 2.3), Some(2));
        assert_eq!(speaker_for(&segs, 0.5, 0.9), Some(1));
        assert_eq!(speaker_for(&segs, 4.5, 4.8), Some(2));
        assert_eq!(speaker_for(&segs, 20.0, 20.5), None);
    }

    #[test]
    fn groups_words_by_speaker_and_gap() {
        let segs = [seg(0.0, 3.0, 1), seg(3.0, 6.0, 2)];
        let words = [
            w("hola", 0.2, 0.5),
            w("equipo", 0.6, 1.0),
            w("gracias", 3.2, 3.6),
            w("Camilo", 3.7, 4.1),
            w("sigo", 9.0, 9.3),
        ];
        let u = build_utterances(&words, &segs);
        assert_eq!(u.len(), 3);
        assert_eq!((u[0].speaker, u[0].text.as_str()), (1, "hola equipo"));
        assert_eq!((u[1].speaker, u[1].text.as_str()), (2, "gracias Camilo"));
        assert_eq!((u[2].speaker, u[2].text.as_str()), (2, "sigo"));
        assert!(u.iter().all(|x| !x.provisional));
    }

    #[test]
    fn interpolation_spreads_time_by_word_length() {
        let words = interpolate_words(" ab  cdef ", 10.0, 16.0);
        assert_eq!(words.len(), 2);
        assert_eq!(words[0], w("ab", 10.0, 12.0));
        assert_eq!(words[1], w("cdef", 12.0, 16.0));
        assert!(interpolate_words("   ", 0.0, 1.0).is_empty());
    }

    #[test]
    fn speaker_change_inside_a_segment_is_kept() {
        // One Whisper segment spanning two speakers splits between them.
        let words = interpolate_words("uno dos tres cuatro", 0.0, 4.0);
        let segs = [seg(0.0, 2.0, 1), seg(2.0, 4.0, 2)];
        let u = build_utterances(&words, &segs);
        assert_eq!(u.len(), 2);
        assert_eq!(u[0].speaker, 1);
        assert_eq!(u[1].speaker, 2);
    }
}
