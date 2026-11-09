import React, { useState } from "react";
import { Loader2, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useMeetingStore } from "../../../stores/meetingStore";

/** Square icon button, same look as the Meetings detail header actions. */
export const IconButton: React.FC<{
  onClick: () => void;
  title: string;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}> = ({ onClick, title, disabled, active, children }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-label={title}
    title={title}
    className={`min-w-8 h-8 px-1.5 rounded-md border flex items-center justify-center transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${
      active
        ? "border-logo-primary/40 bg-logo-primary/15 text-logo-primary hover:bg-logo-primary/25"
        : "border-mid-gray/20 text-text/70 hover:bg-mid-gray/15 hover:text-text"
    }`}
  >
    {children}
  </button>
);

/** Turns an entry's recording into a speaker-labeled meeting, or opens it. */
export const MeetingButton: React.FC<{
  historyId: number;
  disabled?: boolean;
}> = ({ historyId, disabled }) => {
  const { t } = useTranslation();
  const meetingId = useMeetingStore(
    (state) => state.meetingByHistory[historyId],
  );
  const job = useMeetingStore((state) => state.job);
  const models = useMeetingStore((state) => state.models);
  const diarize = useMeetingStore((state) => state.diarize);
  const cancel = useMeetingStore((state) => state.cancel);
  const showMeeting = useMeetingStore((state) => state.showMeeting);
  const downloadModels = useMeetingStore((state) => state.downloadModels);
  const refreshModels = useMeetingStore((state) => state.refreshModels);
  const [downloading, setDownloading] = useState(false);

  if (job?.history_id === historyId || downloading) {
    const percent = downloading
      ? models && models.total > 0
        ? Math.round((models.downloaded / models.total) * 100)
        : 0
      : Math.round((job?.progress ?? 0) * 100);
    return (
      <IconButton
        onClick={() => !downloading && cancel()}
        title={
          downloading
            ? t("meetings.models.downloading", { percent })
            : t("settings.history.meetingProcessing", { percent })
        }
        active
      >
        <span className="inline-flex items-center gap-1">
          <Loader2 width={15} height={15} className="animate-spin" />
          <span className="text-[10px] tabular-nums">{percent}%</span>
        </span>
      </IconButton>
    );
  }

  if (meetingId !== undefined) {
    return (
      <IconButton
        onClick={() => showMeeting(meetingId)}
        title={t("settings.history.viewMeeting")}
        active
      >
        <Users width={15} height={15} />
      </IconButton>
    );
  }

  const start = async () => {
    await refreshModels();
    if (!useMeetingStore.getState().models?.ready) {
      if (!window.confirm(t("settings.history.meetingDownloadConfirm"))) {
        return;
      }
      setDownloading(true);
      const ok = await downloadModels();
      setDownloading(false);
      if (!ok) return;
    }
    await diarize(historyId);
  };

  return (
    <IconButton
      onClick={start}
      disabled={disabled || job !== null}
      title={
        job !== null
          ? t("settings.history.meetingBusy")
          : t("settings.history.markMeeting")
      }
    >
      <Users width={15} height={15} />
    </IconButton>
  );
};
