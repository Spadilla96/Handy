// Stable, distinguishable colors per speaker id.
const SPEAKER_COLORS = [
  "text-sky-400",
  "text-emerald-400",
  "text-amber-400",
  "text-fuchsia-400",
  "text-rose-400",
  "text-lime-400",
  "text-cyan-400",
  "text-orange-400",
];

export const speakerColor = (speaker: number) =>
  speaker > 0
    ? SPEAKER_COLORS[(speaker - 1) % SPEAKER_COLORS.length]
    : "text-mid-gray";
