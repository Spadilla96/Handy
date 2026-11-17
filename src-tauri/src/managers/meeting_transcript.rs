//! Combine timed ASR output (Whisper, run inside Handy) with the diarizer's
//! speaker segments (from `handy-meeting-worker`) into speaker-attributed
//! utterances. Kept free of I/O so it can be unit tested.
//!
//! Whisper (through transcribe.cpp) only times whole segments of a few
//! seconds, and a segment often holds the end of one speaker's turn and the
//! start of the next. Spreading its words evenly over the segment shifts the
//! second speaker's words into the first one's turn, so instead each segment
//! is split between the diarizer turns it overlaps, in proportion to how long
//! each one speaks, with the cut moved to a nearby sentence boundary.

use serde::Deserialize;

use crate::managers::meeting::Utterance;

/// Silence longer than this between two words of the same speaker starts a
/// new utterance.
const MAX_GAP_SECS: f64 = 2.5;
/// A word with no overlapping segment adopts the nearest one within this
/// distance; otherwise it keeps the previous word's speaker.
const MAX_NEAREST_SECS: f64 = 3.0;
/// Diarizer turns shorter than this inside a Whisper segment are ignored:
/// Whisper's segment edges are imprecise and would otherwise hand a word or
/// two to whoever speaks just before or after.
const MIN_TURN_SECS: f64 = 0.5;
/// How far (in words) a speaker change may move to land on a sentence
/// boundary.
const SNAP_WORDS: usize = 3;

/// A transcribed word, in seconds from the start of the recording.
#[derive(Clone, Debug, PartialEq)]
pub struct TimedWord {
    pub text: String,
    pub start: f64,
    pub end: f64,
}

/// A transcribed segment. `words` is empty when the model only times whole
/// segments (Whisper); otherwise it holds the segment's timed words.
#[derive(Clone, Debug, PartialEq)]
pub struct TimedSegment {
    pub text: String,
    pub start: f64,
    pub end: f64,
    pub words: Vec<TimedWord>,
}

impl TimedSegment {
    /// Move the segment (and its words) later by `secs`.
    pub fn shifted(mut self, secs: f64) -> Self {
        self.start += secs;
        self.end += secs;
        for w in &mut self.words {
            w.start += secs;
            w.end += secs;
        }
        self
    }
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

/// The speaker turns inside `[start, end]`: diarizer segments clipped to the
/// span, overlaps resolved in favour of the earlier one (until the next one
/// starts), same-speaker neighbours merged, and turns shorter than
/// [`MIN_TURN_SECS`] dropped (unless all are, then the longest is kept).
fn turns_within(diar: &[SpeakerSegment], start: f64, end: f64) -> Vec<SpeakerSegment> {
    let mut clipped: Vec<SpeakerSegment> = diar
        .iter()
        .map(|s| SpeakerSegment {
            start: s.start.max(start),
            end: s.end.min(end),
            speaker: s.speaker,
        })
        .filter(|s| s.end > s.start)
        .collect();
    clipped.sort_by(|a, b| a.start.total_cmp(&b.start));

    let mut turns: Vec<SpeakerSegment> = Vec::new();
    for seg in clipped {
        if let Some(last) = turns.last_mut() {
            if last.speaker == seg.speaker {
                last.end = last.end.max(seg.end);
                continue;
            }
            if seg.start < last.end {
                last.end = seg.start;
            }
            if last.end <= last.start {
                turns.pop();
            }
        }
        match turns.last_mut() {
            Some(last) if last.speaker == seg.speaker => last.end = last.end.max(seg.end),
            _ => turns.push(seg),
        }
    }

    if turns.len() > 1 {
        let longest = turns
            .iter()
            .copied()
            .max_by(|a, b| (a.end - a.start).total_cmp(&(b.end - b.start)));
        turns.retain(|t| t.end - t.start >= MIN_TURN_SECS);
        if turns.is_empty() {
            turns.extend(longest);
        }
        // Dropping a short turn can leave the same speaker on both sides.
        let mut merged: Vec<SpeakerSegment> = Vec::new();
        for t in turns {
            match merged.last_mut() {
                Some(last) if last.speaker == t.speaker => last.end = t.end,
                _ => merged.push(t),
            }
        }
        turns = merged;
    }
    turns
}

/// True when a speaker change between `words[i - 1]` and `words[i]` falls on
/// a sentence boundary.
fn is_sentence_boundary(words: &[&str], i: usize) -> bool {
    let ends = words[i - 1]
        .trim_end_matches(['"', '\'', ')', '»', '”'])
        .ends_with(['.', '?', '!', '…']);
    let opens = words[i].starts_with(['¿', '¡']);
    ends || opens
}

/// Word indexes where each turn after the first starts. `durations` are the
/// turns' speaking times; each turn gets the share of the text's characters
/// that its share of the time says, then the cut moves to the nearest
/// sentence boundary within [`SNAP_WORDS`]. Every turn keeps at least one
/// word (callers pass no more turns than words).
fn split_points(words: &[&str], durations: &[f64]) -> Vec<usize> {
    let n = words.len();
    let k = durations.len();
    // chars[i] = characters in words[..i].
    let mut chars = vec![0usize; n + 1];
    for (i, w) in words.iter().enumerate() {
        chars[i + 1] = chars[i] + w.chars().count();
    }
    let total_chars = chars[n] as f64;
    let total_time: f64 = durations.iter().sum();

    let mut cuts = Vec::with_capacity(k.saturating_sub(1));
    let mut elapsed = 0.0;
    let mut prev = 0usize;
    for (t, d) in durations.iter().take(k - 1).enumerate() {
        elapsed += d;
        let target = if total_time > 0.0 {
            total_chars * elapsed / total_time
        } else {
            total_chars * (t + 1) as f64 / k as f64
        };
        // Leave room for one word per remaining turn.
        let lo = prev + 1;
        let hi = n - (k - 1 - t);
        let mut cut = (lo..=hi)
            .min_by(|&a, &b| {
                (chars[a] as f64 - target)
                    .abs()
                    .total_cmp(&(chars[b] as f64 - target).abs())
            })
            .unwrap_or(lo);
        let near = cut.saturating_sub(SNAP_WORDS).max(lo)..=(cut + SNAP_WORDS).min(hi);
        if let Some(snapped) = near
            .filter(|&i| is_sentence_boundary(words, i))
            .min_by_key(|&i| i.abs_diff(cut))
        {
            cut = snapped;
        }
        cuts.push(cut);
        prev = cut;
    }
    cuts
}

/// Attribute the words of a segment that has only segment-level timing.
/// `prev_speaker` is used when no diarizer segment is near.
pub fn attribute_segment(
    seg: &TimedSegment,
    diar: &[SpeakerSegment],
    prev_speaker: i32,
) -> Vec<(i32, TimedWord)> {
    let words: Vec<&str> = seg.text.split_whitespace().collect();
    if words.is_empty() {
        return Vec::new();
    }
    let mut turns = turns_within(diar, seg.start, seg.end);
    if turns.is_empty() {
        let speaker = speaker_for(diar, seg.start, seg.end).unwrap_or(prev_speaker);
        return interpolate_words(&seg.text, seg.start, seg.end)
            .into_iter()
            .map(|w| (speaker, w))
            .collect();
    }
    // More turns than words: keep the longest ones, in time order.
    while turns.len() > words.len() {
        let shortest = turns
            .iter()
            .enumerate()
            .min_by(|a, b| (a.1.end - a.1.start).total_cmp(&(b.1.end - b.1.start)))
            .map(|(i, _)| i)
            .unwrap_or(0);
        turns.remove(shortest);
    }

    let durations: Vec<f64> = turns.iter().map(|t| t.end - t.start).collect();
    let mut bounds = vec![0];
    bounds.extend(split_points(&words, &durations));
    bounds.push(words.len());

    let mut out = Vec::with_capacity(words.len());
    for (t, turn) in turns.iter().enumerate() {
        let text = words[bounds[t]..bounds[t + 1]].join(" ");
        out.extend(
            interpolate_words(&text, turn.start, turn.end)
                .into_iter()
                .map(|w| (turn.speaker, w)),
        );
    }
    out
}

/// Attribute every word of `segments` to a speaker: by diarizer turns for
/// segment-timed text, by overlap for word-timed text.
pub fn attribute_all(
    segments: &[TimedSegment],
    diar: &[SpeakerSegment],
) -> Vec<(i32, TimedWord)> {
    let mut out: Vec<(i32, TimedWord)> = Vec::new();
    let mut last_speaker = 0;
    for seg in segments {
        if seg.words.is_empty() {
            out.extend(attribute_segment(seg, diar, last_speaker));
        } else {
            for word in &seg.words {
                let speaker = speaker_for(diar, word.start, word.end).unwrap_or(last_speaker);
                last_speaker = speaker;
                out.push((speaker, word.clone()));
            }
        }
        if let Some((speaker, _)) = out.last() {
            last_speaker = *speaker;
        }
    }
    out
}

/// Group consecutive same-speaker words into utterances.
pub fn build_utterances(words: &[(i32, TimedWord)]) -> Vec<Utterance> {
    let mut out: Vec<Utterance> = Vec::new();
    for (speaker, word) in words {
        let text = word.text.trim();
        if text.is_empty() {
            continue;
        }
        match out.last_mut() {
            Some(u) if u.speaker == *speaker && word.start - u.end <= MAX_GAP_SECS => {
                u.text.push(' ');
                u.text.push_str(text);
                u.end = u.end.max(word.end);
            }
            _ => out.push(Utterance {
                speaker: *speaker,
                start: word.start,
                end: word.end,
                text: text.to_string(),
                provisional: false,
            }),
        }
    }
    out
}

/// Split a timed text into words, spreading `[start, end]` over them in
/// proportion to their length.
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

    fn tseg(text: &str, start: f64, end: f64) -> TimedSegment {
        TimedSegment {
            text: text.into(),
            start,
            end,
            words: Vec::new(),
        }
    }

    /// (speaker, text) of each utterance.
    fn summary(words: &[(i32, TimedWord)]) -> Vec<(i32, String)> {
        build_utterances(words)
            .into_iter()
            .map(|u| (u.speaker, u.text))
            .collect()
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
    fn word_timed_segments_use_overlap() {
        let diar = [seg(0.0, 3.0, 1), seg(3.0, 6.0, 2)];
        let s = TimedSegment {
            text: "hola equipo gracias Camilo".into(),
            start: 0.0,
            end: 6.0,
            words: vec![
                w("hola", 0.2, 0.5),
                w("equipo", 0.6, 1.0),
                w("gracias", 3.2, 3.6),
                w("Camilo", 3.7, 4.1),
            ],
        };
        let words = attribute_all(&[s], &diar);
        assert_eq!(
            summary(&words),
            vec![
                (1, "hola equipo".to_string()),
                (2, "gracias Camilo".to_string())
            ]
        );
    }

    #[test]
    fn speaker_change_snaps_to_sentence_end() {
        // Real case: Sebastián says "Solamente retail." and Letizia goes on.
        let diar = [seg(0.0, 1.6, 2), seg(2.1, 9.0, 1)];
        let s = tseg(
            "Solamente retail. Tiene los totales. Pero, pero tiene la información de los totales para ese retail.",
            0.0,
            9.0,
        );
        let words = attribute_segment(&s, &diar, 0);
        assert_eq!(
            summary(&words),
            vec![
                (2, "Solamente retail.".to_string()),
                (
                    1,
                    "Tiene los totales. Pero, pero tiene la información de los totales para ese retail."
                        .to_string()
                )
            ]
        );
        // The second speaker's words are timed inside their own turn.
        assert!(words.iter().filter(|(s, _)| *s == 1).all(|(_, w)| w.start >= 2.1));
    }

    #[test]
    fn opening_question_mark_starts_the_next_turn() {
        let diar = [seg(0.0, 5.5, 2), seg(5.8, 7.5, 1)];
        let s = tseg(
            "Ya lo estamos trabajando, pero todavía no lo tenemos. ¿Cómo la información",
            0.0,
            7.5,
        );
        let words = attribute_segment(&s, &diar, 0);
        assert_eq!(
            summary(&words),
            vec![
                (
                    2,
                    "Ya lo estamos trabajando, pero todavía no lo tenemos.".to_string()
                ),
                (1, "¿Cómo la información".to_string())
            ]
        );
    }

    #[test]
    fn long_pause_does_not_pull_words_into_the_previous_turn() {
        // Two words, a 5 s silence, then three more by someone else. Even
        // spreading over the segment would put "tres" in speaker 1's time.
        let diar = [seg(0.0, 0.8, 1), seg(6.0, 8.0, 2)];
        let s = tseg("uno ok tres cuatro cinco", 0.0, 8.0);
        let words = attribute_segment(&s, &diar, 0);
        assert_eq!(
            summary(&words),
            vec![(1, "uno ok".to_string()), (2, "tres cuatro cinco".to_string())]
        );
    }

    #[test]
    fn tiny_turns_at_the_edges_are_ignored() {
        let diar = [seg(0.0, 0.3, 1), seg(0.3, 4.0, 2), seg(3.8, 4.2, 3)];
        let s = tseg("todo esto es del hablante dos", 0.0, 4.2);
        let words = attribute_segment(&s, &diar, 0);
        assert!(words.iter().all(|(s, _)| *s == 2));
    }

    #[test]
    fn without_punctuation_the_proportional_cut_stays() {
        let diar = [seg(0.0, 2.0, 1), seg(2.0, 4.0, 2)];
        let s = tseg("aaaa bbbb cccc dddd", 0.0, 4.0);
        let words = attribute_segment(&s, &diar, 0);
        assert_eq!(
            summary(&words),
            vec![(1, "aaaa bbbb".to_string()), (2, "cccc dddd".to_string())]
        );
    }

    #[test]
    fn segment_without_speakers_keeps_the_previous_one() {
        let diar = [seg(0.0, 1.0, 3)];
        let segments = [tseg("hola", 0.0, 1.0), tseg("sigo aquí", 20.0, 21.0)];
        let words = attribute_all(&segments, &diar);
        assert!(words.iter().all(|(s, _)| *s == 3));
    }

    #[test]
    fn more_turns_than_words_keeps_the_longest() {
        let diar = [seg(0.0, 1.0, 1), seg(1.0, 3.0, 2), seg(3.0, 3.8, 1)];
        let s = tseg("vale", 0.0, 3.8);
        let words = attribute_segment(&s, &diar, 0);
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].0, 2);
    }

    #[test]
    fn groups_by_speaker_and_gap() {
        let words = vec![
            (1, w("hola", 0.2, 0.5)),
            (1, w("equipo", 0.6, 1.0)),
            (2, w("gracias", 3.2, 3.6)),
            (2, w("sigo", 9.0, 9.3)),
        ];
        assert_eq!(
            summary(&words),
            vec![
                (1, "hola equipo".to_string()),
                (2, "gracias".to_string()),
                (2, "sigo".to_string())
            ]
        );
    }

    #[test]
    fn interpolation_spreads_time_by_word_length() {
        let words = interpolate_words(" ab  cdef ", 10.0, 16.0);
        assert_eq!(words, vec![w("ab", 10.0, 12.0), w("cdef", 12.0, 16.0)]);
        assert!(interpolate_words("   ", 0.0, 1.0).is_empty());
    }

    #[test]
    fn shifting_moves_segment_and_words() {
        let s = TimedSegment {
            text: "a".into(),
            start: 1.0,
            end: 2.0,
            words: vec![w("a", 1.0, 2.0)],
        }
        .shifted(60.0);
        assert_eq!((s.start, s.end), (61.0, 62.0));
        assert_eq!(s.words[0], w("a", 61.0, 62.0));
    }
}
