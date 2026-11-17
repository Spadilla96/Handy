import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DiarizationJob } from "@/bindings";
import { speakerColor } from "./speakerColors";

const formatClock = (ms: number) => {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

/**
 * Live view of a meeting job (from History or a meeting re-transcription):
 * progress bar, stage, elapsed/remaining time and the speaker-attributed
 * transcript so far.
 */
export const MeetingJobProgress: React.FC<{ job: DiarizationJob }> = ({
  job,
}) => {
  const { t } = useTranslation();
  // A ticking clock so elapsed/remaining time move between updates.
  const [now, setNow] = useState(() => Date.now());
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  useEffect(() => {
    setReceivedAt(Date.now());
  }, [job]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const sinceUpdate = now - receivedAt;
  const percent = Math.round(job.progress * 100);
  const transcribing = job.stage === "transcribing";

  return (
    <div className="space-y-3">
      <style>{`
        @keyframes transcribe-pulse {
          0%, 100% { color: color-mix(in srgb, var(--color-text) 40%, transparent); }
          50% { color: color-mix(in srgb, var(--color-text) 90%, transparent); }
        }
      `}</style>
      <div className="space-y-1.5">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-mid-gray/20">
          <div
            className="h-full rounded-full bg-logo-primary transition-[width] duration-500"
            style={{ width: `${percent}%` }}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 text-xs text-mid-gray tabular-nums">
          <span>
            {percent}% ·{" "}
            {transcribing
              ? t("settings.history.progressParts", {
                  done: job.done,
                  total: job.total,
                })
              : t("settings.history.meetingStageDiarizing")}
          </span>
          <span>
            {t("settings.history.progressElapsed", {
              time: formatClock(job.elapsed_ms + sinceUpdate),
            })}
            {transcribing && (
              <>
                {" · "}
                {job.remaining_ms !== null
                  ? t("settings.history.progressRemaining", {
                      time: formatClock(job.remaining_ms - sinceUpdate),
                    })
                  : t("settings.history.progressEstimating")}
              </>
            )}
          </span>
        </div>
      </div>
      {job.utterances.length > 0 ? (
        job.utterances.map((u, i) => (
          <p
            key={i}
            className="text-sm leading-relaxed select-text cursor-text break-words"
          >
            <span className={`font-semibold ${speakerColor(u.speaker)}`}>
              {u.speaker > 0
                ? t("meetings.speaker", { n: u.speaker })
                : t("meetings.unknownSpeaker")}
            </span>{" "}
            <span className="text-text/90">{u.text}</span>
          </p>
        ))
      ) : (
        <p
          className="text-sm leading-relaxed"
          style={{ animation: "transcribe-pulse 3s ease-in-out infinite" }}
        >
          {transcribing
            ? t("settings.history.transcribing")
            : t("settings.history.meetingStageDiarizing")}
        </p>
      )}
    </div>
  );
};
