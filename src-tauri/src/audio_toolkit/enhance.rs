//! Light speech enhancement for recordings of distant voices (in-room
//! meetings): a 100 Hz high-pass followed by a smoothed dynamic volume
//! normalization, so quiet speakers reach the model at a usable level.
//!
//! Deliberately no noise reduction: in tests a spectral denoiser made the
//! transcription worse (artifacts, `<unk>` tokens).

/// Sample rate of the audio handled here (matches `read_wav_samples`).
const SAMPLE_RATE: f32 = 16_000.0;
const HIGHPASS_HZ: f32 = 100.0;
/// Gain is computed per 250 ms frame.
const FRAME: usize = 4_000;
/// Gaussian smoothing of the per-frame gain, in frames either side.
const SMOOTH_HALF: usize = 15;
const SMOOTH_SIGMA: f32 = 5.0;
/// Peak every frame is brought towards.
const TARGET_PEAK: f32 = 0.9;
/// Never amplify more than this (keeps near-silence from becoming loud noise).
const MAX_GAIN: f32 = 20.0;
/// Never exceed this absolute sample value.
const CEILING: f32 = 0.99;

/// Apply the high-pass and the volume normalization. Output has the same
/// length as the input.
pub fn enhance_speech(samples: &[f32]) -> Vec<f32> {
    let mut out = high_pass(samples);
    normalize_volume(&mut out);
    out
}

/// 2nd-order Butterworth high-pass (RBJ biquad).
fn high_pass(samples: &[f32]) -> Vec<f32> {
    let w0 = 2.0 * std::f32::consts::PI * HIGHPASS_HZ / SAMPLE_RATE;
    let (sin, cos) = w0.sin_cos();
    let alpha = sin / (2.0 * std::f32::consts::FRAC_1_SQRT_2);
    let a0 = 1.0 + alpha;
    let b0 = (1.0 + cos) / 2.0 / a0;
    let b1 = -(1.0 + cos) / a0;
    let b2 = b0;
    let a1 = -2.0 * cos / a0;
    let a2 = (1.0 - alpha) / a0;

    let (mut x1, mut x2, mut y1, mut y2) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
    samples
        .iter()
        .map(|&x| {
            let y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            x2 = x1;
            x1 = x;
            y2 = y1;
            y1 = y;
            y
        })
        .collect()
}

fn normalize_volume(samples: &mut [f32]) {
    if samples.is_empty() {
        return;
    }

    // Desired gain per frame: bring its peak to TARGET_PEAK, capped.
    let wanted: Vec<f32> = samples
        .chunks(FRAME)
        .map(|frame| {
            let peak = frame.iter().fold(0.0f32, |m, s| m.max(s.abs()));
            if peak <= f32::EPSILON {
                1.0
            } else {
                (TARGET_PEAK / peak).min(MAX_GAIN)
            }
        })
        .collect();

    // Gaussian-smooth the gains so volume changes are gradual.
    let weights: Vec<f32> = (0..=2 * SMOOTH_HALF)
        .map(|i| {
            let d = i as f32 - SMOOTH_HALF as f32;
            (-(d * d) / (2.0 * SMOOTH_SIGMA * SMOOTH_SIGMA)).exp()
        })
        .collect();
    let smoothed: Vec<f32> = (0..wanted.len())
        .map(|i| {
            let (mut acc, mut total) = (0.0f32, 0.0f32);
            for (k, w) in weights.iter().enumerate() {
                let j = i as isize + k as isize - SMOOTH_HALF as isize;
                if j >= 0 && (j as usize) < wanted.len() {
                    acc += w * wanted[j as usize];
                    total += w;
                }
            }
            acc / total
        })
        .collect();

    // Apply, interpolating linearly between frame centres to avoid steps.
    for (n, s) in samples.iter_mut().enumerate() {
        let pos = (n as f32 + 0.5) / FRAME as f32 - 0.5;
        let lo = pos.floor().max(0.0) as usize;
        let hi = (lo + 1).min(smoothed.len() - 1);
        let t = (pos - lo as f32).clamp(0.0, 1.0);
        let gain = smoothed[lo.min(smoothed.len() - 1)] * (1.0 - t) + smoothed[hi] * t;
        *s = (*s * gain).clamp(-CEILING, CEILING);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(hz: f32, amp: f32, secs: f32) -> Vec<f32> {
        (0..(SAMPLE_RATE * secs) as usize)
            .map(|n| amp * (2.0 * std::f32::consts::PI * hz * n as f32 / SAMPLE_RATE).sin())
            .collect()
    }

    fn peak(s: &[f32]) -> f32 {
        s.iter().fold(0.0, |m, x| m.max(x.abs()))
    }

    #[test]
    fn keeps_length_and_handles_empty() {
        assert!(enhance_speech(&[]).is_empty());
        let input = tone(300.0, 0.05, 1.3);
        assert_eq!(enhance_speech(&input).len(), input.len());
    }

    #[test]
    fn raises_quiet_speech_without_clipping() {
        let input = tone(300.0, 0.05, 5.0);
        let out = enhance_speech(&input);
        let mid = &out[out.len() / 4..out.len() * 3 / 4];
        assert!(peak(mid) > 0.5, "quiet tone should be brought up");
        assert!(peak(&out) <= CEILING + 1e-6);
    }

    #[test]
    fn removes_rumble_below_cutoff() {
        let input = tone(20.0, 0.3, 3.0);
        let filtered = high_pass(&input);
        let tail = &filtered[filtered.len() / 2..];
        assert!(peak(tail) < 0.05, "20 Hz rumble should be strongly attenuated");
    }

    #[test]
    fn silence_stays_silent() {
        let out = enhance_speech(&vec![0.0; 10_000]);
        assert!(peak(&out) == 0.0);
    }
}
