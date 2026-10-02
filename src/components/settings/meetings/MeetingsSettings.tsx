import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ArrowLeft, Copy, Download, Loader2, Trash2, X } from "lucide-react";
import { commands, type Meeting, type Utterance } from "@/bindings";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { Button } from "../../ui/Button";
import { AudioPlayer, AudioPlayerGroup } from "../../ui/AudioPlayer";
import { copyToClipboard } from "../history/clipboard";
import { useMeetingStore } from "../../../stores/meetingStore";

const formatTs = (secs: number) => {
  const s = Math.max(0, Math.floor(secs));
  const mm = String(Math.floor(s / 60) % 60).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${mm}:${ss}`;
};

const formatDate = (unix: number) =>
  new Date(unix * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

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
const speakerColor = (speaker: number) =>
  speaker > 0
    ? SPEAKER_COLORS[(speaker - 1) % SPEAKER_COLORS.length]
    : "text-mid-gray";

interface TranscriptProps {
  utterances: Utterance[];
  nameFor: (speaker: number) => string;
  onSpeakerClick?: (speaker: number) => void;
}

const Transcript: React.FC<TranscriptProps> = ({
  utterances,
  nameFor,
  onSpeakerClick,
}) => (
  <div className="space-y-3">
    {utterances.map((u, i) => (
      <div
        key={`${u.start}-${i}`}
        className={u.provisional ? "opacity-60" : undefined}
      >
        <div className="flex items-baseline gap-2 text-xs">
          <span className="text-mid-gray tabular-nums">
            {formatTs(u.start)}
          </span>
          <button
            type="button"
            className={`font-semibold ${speakerColor(u.speaker)} ${
              onSpeakerClick
                ? "hover:underline cursor-pointer"
                : "cursor-default"
            }`}
            onClick={() => onSpeakerClick?.(u.speaker)}
          >
            {nameFor(u.speaker)}
          </button>
        </div>
        <p className="text-sm leading-relaxed">{u.text}</p>
      </div>
    ))}
  </div>
);

export const MeetingsSettings: React.FC = () => {
  const { t } = useTranslation();
  const models = useMeetingStore((state) => state.models);
  const meetings = useMeetingStore((state) => state.meetings);
  const job = useMeetingStore((state) => state.job);
  const openRequest = useMeetingStore((state) => state.openRequest);
  const consumeOpenRequest = useMeetingStore(
    (state) => state.consumeOpenRequest,
  );
  const refreshList = useMeetingStore((state) => state.refreshMeetings);
  const downloadModels = useMeetingStore((state) => state.downloadModels);
  const cancelJob = useMeetingStore((state) => state.cancel);
  const [selected, setSelected] = useState<Meeting | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [editingSpeaker, setEditingSpeaker] = useState<{
    speaker: number;
    name: string;
  } | null>(null);

  const genericName = useCallback(
    (speaker: number) =>
      speaker > 0
        ? t("meetings.speaker", { n: speaker })
        : t("meetings.unknownSpeaker"),
    [t],
  );

  const openMeeting = useCallback(async (id: number) => {
    const res = await commands.getMeeting(id);
    if (res.status === "ok") setSelected(res.data);
    else setError(res.error);
  }, []);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  // "View meeting" from History (or a toast) lands here.
  useEffect(() => {
    if (openRequest === null) return;
    const id = consumeOpenRequest();
    if (id !== null) openMeeting(id);
  }, [openRequest, consumeOpenRequest, openMeeting]);

  const nameFor = (meeting: Meeting) => (speaker: number) =>
    meeting.speaker_names[String(speaker)] ?? genericName(speaker);

  const saveSpeakerName = async () => {
    if (!selected || !editingSpeaker) return;
    const res = await commands.renameMeetingSpeaker(
      selected.id,
      editingSpeaker.speaker,
      editingSpeaker.name,
    );
    setEditingSpeaker(null);
    if (res.status === "error") setError(res.error);
    openMeeting(selected.id);
  };

  const saveTitle = async () => {
    if (!selected || editingTitle === null) return;
    const res = await commands.renameMeeting(selected.id, editingTitle);
    setEditingTitle(null);
    if (res.status === "error") setError(res.error);
    openMeeting(selected.id);
    refreshList();
  };

  const copyMeeting = async () => {
    if (!selected) return;
    const res = await commands.exportMeetingMarkdown(selected.id);
    if (res.status === "ok" && (await copyToClipboard(res.data))) {
      setNotice(t("meetings.detail.copied"));
    }
  };

  const saveMarkdown = async () => {
    if (!selected) return;
    const res = await commands.saveMeetingMarkdown(selected.id);
    if (res.status === "ok") {
      setNotice(t("meetings.detail.saved", { path: res.data }));
    } else {
      setError(res.error);
    }
  };

  const deleteMeeting = async () => {
    if (!selected || !window.confirm(t("meetings.detail.confirmDelete"))) {
      return;
    }
    const res = await commands.deleteMeeting(selected.id);
    if (res.status === "error") setError(res.error);
    setSelected(null);
    refreshList();
  };

  const loadAudio = async () => {
    if (!selected) return null;
    const res = await commands.getMeetingAudioPath(selected.id);
    return res.status === "ok" ? convertFileSrc(res.data, "asset") : null;
  };

  const download = async () => {
    setError(null);
    await downloadModels();
  };

  const percent =
    models && models.total > 0
      ? Math.round((models.downloaded / models.total) * 100)
      : 0;

  // ---- Detail view --------------------------------------------------------
  if (selected) {
    const names = nameFor(selected);
    return (
      <div className="max-w-3xl w-full mx-auto space-y-4">
        <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
          <span className="inline-flex items-center gap-1">
            <ArrowLeft size={14} />
            {t("meetings.detail.back")}
          </span>
        </Button>
        <div className="space-y-1">
          {editingTitle !== null ? (
            <input
              autoFocus
              className="w-full bg-transparent border-b border-mid-gray/40 text-lg font-semibold focus:outline-none"
              value={editingTitle}
              onChange={(e) => setEditingTitle(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => e.key === "Enter" && saveTitle()}
            />
          ) : (
            <button
              type="button"
              className="text-lg font-semibold hover:underline text-left"
              title={t("meetings.detail.rename")}
              onClick={() => setEditingTitle(selected.title)}
            >
              {selected.title}
            </button>
          )}
          <p className="text-xs text-mid-gray">
            {formatDate(selected.started_at)} ·{" "}
            {formatTs(selected.ended_at - selected.started_at)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AudioPlayerGroup>
            <AudioPlayer
              onLoadRequest={loadAudio}
              className="flex-1 min-w-48"
            />
          </AudioPlayerGroup>
          <Button variant="secondary" size="sm" onClick={copyMeeting}>
            <span className="inline-flex items-center gap-1">
              <Copy size={14} />
              {t("meetings.detail.copy")}
            </span>
          </Button>
          <Button variant="secondary" size="sm" onClick={saveMarkdown}>
            <span className="inline-flex items-center gap-1">
              <Download size={14} />
              {t("meetings.detail.save")}
            </span>
          </Button>
          <Button variant="danger-ghost" size="sm" onClick={deleteMeeting}>
            <span className="inline-flex items-center gap-1">
              <Trash2 size={14} />
              {t("meetings.detail.delete")}
            </span>
          </Button>
        </div>
        {notice && <p className="text-xs text-mid-gray">{notice}</p>}
        {error && <p className="text-xs text-red-400">{error}</p>}
        <p className="text-xs text-mid-gray">
          {t("meetings.detail.renameSpeakerHint")}
        </p>
        {editingSpeaker && (
          <div className="flex items-center gap-2">
            <label className="text-xs text-mid-gray">
              {t("meetings.detail.renameSpeakerPrompt", {
                speaker: genericName(editingSpeaker.speaker),
              })}
            </label>
            <input
              autoFocus
              className="flex-1 bg-transparent border-b border-mid-gray/40 text-sm focus:outline-none"
              value={editingSpeaker.name}
              onChange={(e) =>
                setEditingSpeaker({ ...editingSpeaker, name: e.target.value })
              }
              onBlur={saveSpeakerName}
              onKeyDown={(e) => e.key === "Enter" && saveSpeakerName()}
            />
          </div>
        )}
        <Transcript
          utterances={selected.utterances}
          nameFor={names}
          onSpeakerClick={(speaker) =>
            setEditingSpeaker({
              speaker,
              name: selected.speaker_names[String(speaker)] ?? "",
            })
          }
        />
      </div>
    );
  }

  // ---- Main view ------------------------------------------------------------
  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <SettingsGroup
        title={t("meetings.title")}
        description={t("meetings.description")}
      >
        {job ? (
          <div className="p-4 flex items-center gap-3">
            <Loader2 size={16} className="animate-spin text-logo-primary" />
            <div className="flex-1 space-y-1">
              <p className="text-sm">
                {t("meetings.diarize.running", {
                  percent: Math.round(job.progress * 100),
                })}
              </p>
              <div className="h-1 rounded bg-mid-gray/20 overflow-hidden">
                <div
                  className="h-full bg-logo-primary transition-[width]"
                  style={{ width: `${Math.round(job.progress * 100)}%` }}
                />
              </div>
            </div>
            <Button variant="secondary" size="sm" onClick={cancelJob}>
              <span className="inline-flex items-center gap-1">
                <X size={14} />
                {t("meetings.diarize.cancel")}
              </span>
            </Button>
          </div>
        ) : (
          <p className="p-4 text-sm text-mid-gray">{t("meetings.howTo")}</p>
        )}
      </SettingsGroup>

      {models && !models.ready && (
        <SettingsGroup
          title={t("meetings.models.title")}
          description={t("meetings.models.description")}
        >
          <div className="p-4">
            <Button
              variant="primary"
              disabled={models.downloading}
              onClick={download}
            >
              {models.downloading
                ? t("meetings.models.downloading", { percent })
                : t("meetings.models.download")}
            </Button>
          </div>
        </SettingsGroup>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}

      <SettingsGroup title={t("meetings.list.title")}>
        {meetings.length === 0 ? (
          <p className="p-4 text-sm text-mid-gray">
            {t("meetings.list.empty")}
          </p>
        ) : (
          meetings.map((m) => (
            <button
              key={m.id}
              type="button"
              className="w-full text-left px-4 py-3 hover:bg-mid-gray/10 border-b border-mid-gray/10 last:border-b-0"
              onClick={() => openMeeting(m.id)}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium">{m.title}</span>
                <span className="text-xs text-mid-gray">
                  {formatTs(m.ended_at - m.started_at)} ·{" "}
                  {t("meetings.list.speakers", { count: m.speaker_count })}
                </span>
              </div>
              <p className="text-xs text-mid-gray truncate">{m.preview}</p>
            </button>
          ))
        )}
      </SettingsGroup>
    </div>
  );
};
