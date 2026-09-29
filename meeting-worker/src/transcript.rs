//! Turns ASR words (with timestamps) and diarization segments into
//! speaker-attributed utterances. Kept free of FFI so it can be unit tested.

use serde::Serialize;

use crate::nemo_ffi::{AsrWord, DiarSegment};

/// Silence longer than this between two words of the same speaker starts a
/// new utterance.
const MAX_GAP_SECS: f64 = 2.5;
/// A word with no overlapping segment adopts the nearest one within this
/// distance; otherwise it keeps the previous word's speaker.
const MAX_NEAREST_SECS: f64 = 3.0;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Utterance {
    /// 1-based diarizer speaker id; 0 = not yet attributed.
    pub speaker: i32,
    pub start: f64,
    pub end: f64,
    pub text: String,
    /// True while the words or their speaker may still change.
    pub provisional: bool,
    /// How many input words this utterance consumed (for incremental commits).
    #[serde(skip)]
    pub word_count: usize,
}

/// Speaker for the span `[start, end]`: largest overlap wins (ties go to the
/// shorter, more specific segment); with no overlap, the nearest segment if
/// close enough.
pub fn speaker_for(segments: &[DiarSegment], start: f64, end: f64) -> Option<i32> {
    let mut best: Option<(&DiarSegment, f64)> = None;
    for seg in segments {
        let overlap = end.min(seg.end_time) - start.max(seg.start_time);
        if overlap <= 0.0 {
            continue;
        }
        let better = match best {
            None => true,
            Some((b, bo)) => {
                overlap > bo
                    || (overlap == bo
                        && (seg.end_time - seg.start_time) < (b.end_time - b.start_time))
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
            let d = if mid < s.start_time {
                s.start_time - mid
            } else {
                mid - s.end_time
            };
            (s, d.max(0.0))
        })
        .filter(|(_, d)| *d <= MAX_NEAREST_SECS)
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(s, _)| s.speaker)
}

/// Attribute every word and group consecutive same-speaker words into
/// utterances. Words ending after `stable_until` (seconds) are provisional,
/// as are `interim` words (not yet finalized by the ASR). Callers drop empty
/// words beforehand so `word_count` indexes straight into their word list.
pub fn build_utterances(
    final_words: &[AsrWord],
    interim_words: &[AsrWord],
    segments: &[DiarSegment],
    stable_until: f64,
) -> Vec<Utterance> {
    let mut out: Vec<Utterance> = Vec::new();
    let mut last_speaker = 0;

    let all = final_words
        .iter()
        .map(|w| (w, false))
        .chain(interim_words.iter().map(|w| (w, true)));

    for (word, interim) in all {
        let text = word.text.trim();
        let speaker = speaker_for(segments, word.start, word.end).unwrap_or(last_speaker);
        last_speaker = speaker;
        let provisional = interim || word.end > stable_until;

        match out.last_mut() {
            Some(u) if u.speaker == speaker && word.start - u.end <= MAX_GAP_SECS => {
                u.text.push(' ');
                u.text.push_str(text);
                u.end = u.end.max(word.end);
                u.provisional |= provisional;
                u.word_count += 1;
            }
            _ => out.push(Utterance {
                speaker,
                start: word.start,
                end: word.end,
                text: text.to_string(),
                provisional,
                word_count: 1,
            }),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(text: &str, start: f64, end: f64) -> AsrWord {
        AsrWord {
            text: text.into(),
            start,
            end,
        }
    }

    fn seg(start: f64, end: f64, speaker: i32) -> DiarSegment {
        DiarSegment {
            start_time: start,
            end_time: end,
            speaker,
        }
    }

    #[test]
    fn largest_overlap_wins_and_nearest_fills_gaps() {
        let segs = [seg(0.0, 2.0, 1), seg(1.8, 4.0, 2)];
        assert_eq!(speaker_for(&segs, 1.7, 2.3), Some(2));
        assert_eq!(speaker_for(&segs, 0.5, 0.9), Some(1));
        // Just past the last segment: nearest.
        assert_eq!(speaker_for(&segs, 4.5, 4.8), Some(2));
        // Far from everything: unknown.
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
        let u = build_utterances(&words, &[], &segs, 100.0);
        assert_eq!(u.len(), 3);
        assert_eq!((u[0].speaker, u[0].text.as_str()), (1, "hola equipo"));
        assert_eq!((u[1].speaker, u[1].text.as_str()), (2, "gracias Camilo"));
        // Beyond any segment: keeps the previous speaker but the long gap
        // starts a new utterance.
        assert_eq!((u[2].speaker, u[2].text.as_str()), (2, "sigo"));
        assert!(u.iter().all(|x| !x.provisional));
    }

    #[test]
    fn recent_and_interim_words_are_provisional() {
        let segs = [seg(0.0, 10.0, 1)];
        let finals = [w("uno", 1.0, 1.2), w("dos", 8.0, 8.2)];
        let interim = [w("tres", 8.4, 8.6)];
        let u = build_utterances(&finals, &interim, &segs, 5.0);
        assert_eq!(u.len(), 1);
        assert!(u[0].provisional);

        let u = build_utterances(&finals[..1], &[], &segs, 5.0);
        assert!(!u[0].provisional);
    }
}
