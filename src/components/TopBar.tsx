import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Mic, Square, X } from "lucide-react";
import { commands } from "@/bindings";
import { useRecordingStore } from "../stores/recordingStore";

const POLL_INTERVAL_MS = 500;
const BAR_DELAYS_MS = [0, 120, 240, 60, 180, 300, 90, 210];

const formatElapsed = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(total / 3600);
  const mm = String(Math.floor(total / 60) % 60).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
};

interface TopBarProps {
  title: string;
}

export const TopBar: React.FC<TopBarProps> = ({ title }) => {
  const { t } = useTranslation();
  const isRecording = useRecordingStore((s) => s.isRecording);
  const startedAt = useRecordingStore((s) => s.startedAt);
  const refresh = useRecordingStore((s) => s.refresh);
  const [now, setNow] = useState(() => Date.now());

  // Poll the backend recording state while the window is visible.
  useEffect(() => {
    refresh();
    const id = window.setInterval(() => {
      if (!document.hidden) refresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  // Tick the timer only while recording.
  useEffect(() => {
    if (!isRecording) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isRecording]);

  const toggle = async () => {
    await commands.toggleTranscription();
    refresh();
  };

  const cancel = async () => {
    await commands.cancelOperation();
    refresh();
  };

  return (
    <header className="flex items-center gap-4 h-14 shrink-0 px-5 border-b border-mid-gray/20">
      <h1 className="text-base font-semibold truncate">{title}</h1>
      <div className="flex-1" />
      {isRecording ? (
        <div
          role="status"
          className="flex items-center gap-3 h-9 ps-4 pe-1.5 rounded-full bg-logo-primary/15 border border-logo-primary/40"
        >
          <span className="size-2 rounded-full bg-logo-primary animate-pulse" />
          <span className="text-sm font-semibold tabular-nums text-logo-primary">
            {formatElapsed(now - (startedAt ?? now))}
          </span>
          <span className="flex items-center gap-0.5 h-4" aria-hidden="true">
            {BAR_DELAYS_MS.map((delay, i) => (
              <span
                key={i}
                className="w-0.5 h-full rounded-full bg-logo-primary animate-pulse"
                style={{ animationDelay: `${delay}ms` }}
              />
            ))}
          </span>
          <button
            type="button"
            onClick={cancel}
            aria-label={t("topBar.cancel")}
            title={t("topBar.cancel")}
            className="size-7 rounded-full flex items-center justify-center bg-mid-gray/20 hover:bg-mid-gray/30 cursor-pointer"
          >
            <X size={14} />
          </button>
          <button
            type="button"
            onClick={toggle}
            aria-label={t("topBar.stop")}
            title={t("topBar.stop")}
            className="size-7 rounded-full flex items-center justify-center bg-text text-background hover:opacity-80 cursor-pointer"
          >
            <Square size={12} fill="currentColor" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={toggle}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-lg text-sm font-semibold text-white bg-background-ui hover:bg-background-ui/80 cursor-pointer"
        >
          <Mic size={16} />
          {t("topBar.newRecording")}
        </button>
      )}
    </header>
  );
};
