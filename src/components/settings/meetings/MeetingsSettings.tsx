import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ArrowLeft, Circle, Copy, Download, Square, Trash2 } from "lucide-react";
import {
  commands,
  type Meeting,
  type MeetingModelsStatus,
  type MeetingStatus,
  type MeetingSummary,
  type MeetingTranscriptEvent,
  type Utterance,
} from "@/bindings";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { ToggleSwitch } from "../../ui/ToggleSwitch";
import { Button } from "../../ui/Button";
import { AudioPlayer, AudioPlayerGroup } from "../../ui/AudioPlayer";
import { useSettings } from "../../../hooks/useSettings";
import { copyToClipboard } from "../history/clipboard";

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
              onSpeakerClick ? "hover:underline cursor-pointer" : "cursor-default"
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
  const { getSetting, updateSetting, isUpdating } = useSettings();

  const [status, setStatus] = useState<MeetingStatus | null>(null);
  const [models, setModels] = useState<MeetingModelsStatus | null>(null);
  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);
  const [selected, setSelected] = useState<Meeting | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [editingSpeaker, setEditingSpeaker] = useState<{
    speaker: number;
    name: string;
  } | null>(null);
  const liveEndRef = useRef<HTMLDivElement>(null);

  const genericName = useCallback(
    (speaker: number) =>
      speaker > 0
        ? t("meetings.speaker", { n: speaker })
        : t("meetings.unknownSpeaker"),
    [t],
  );

  const refreshStatus = useCallback(async () => {
    setStatus(await commands.getMeetingStatus());
  }, []);
  const refreshModels = useCallback(async () => {
    setModels(await commands.getMeetingModelsStatus());
  }, []);
  const refreshList = useCallback(async () => {
    const res = await commands.listMeetings();
    if (res.status === "ok") setMeetings(res.data);
  }, []);
  const openMeeting = useCallback(async (id: number) => {
    const res = await commands.getMeeting(id);
    if (res.status === "ok") setSelected(res.data);
    else setError(res.error);
  }, []);

  useEffect(() => {
    refreshStatus();
    refreshModels();
    refreshList();
    const unlisteners = [
      listen("meeting-state", () => {
        refreshStatus();
        refreshList();
      }),
      listen<MeetingTranscriptEvent>("meeting-transcript", (event) => {
        setStatus((prev) =>
          prev
            ? {
                ...prev,
                committed: [...prev.committed, ...event.payload.committed],
                tail: event.payload.tail,
                audio_s: event.payload.audio_s,
                transcribed_s: event.payload.transcribed_s,
              }
            : prev,
        );
      }),
      listen<MeetingModelsStatus>("meeting-models-progress", (event) =>
        setModels(event.payload),
      ),
      listen<number>("meeting-saved", (event) => {
        refreshList();
        openMeeting(event.payload);
      }),
      listen<string>("meeting-error", (event) => setError(event.payload)),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((un) => un()));
    };
  }, [refreshStatus, refreshModels, refreshList, openMeeting]);

  // Clock for the elapsed-time display while recording.
  useEffect(() => {
    if (!status?.active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [status?.active]);

  // Keep the live transcript scrolled to the newest line.
  useEffect(() => {
    liveEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [status?.committed.length, status?.tail]);

  const start = async () => {
    setError(null);
    setBusy(true);
    const res = await commands.startMeeting(false);
    setBusy(false);
    if (res.status === "error") {
      setError(
        res.error === "models-missing"
          ? t("meetings.errors.modelsMissing")
          : res.error,
      );
    }
    refreshStatus();
  };

  const stop = async () => {
    setError(null);
    setBusy(true);
    const res = await commands.stopMeeting();
    setBusy(false);
    if (res.status === "error") setError(res.error);
    refreshStatus();
  };

  const download = async () => {
    setError(null);
    const res = await commands.downloadMeetingModels();
    if (res.status === "error") setError(res.error);
    refreshModels();
  };

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

  const lag =
    status?.active && !status.finishing
      ? Math.max(0, status.audio_s - status.transcribed_s)
      : 0;
  const elapsed =
    status?.active && status.started_at
      ? (now - status.started_at * 1000) / 1000
      : 0;
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
            <AudioPlayer onLoadRequest={loadAudio} className="flex-1 min-w-48" />
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
  const live = status ? [...status.committed, ...status.tail] : [];
  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <SettingsGroup
        title={t("meetings.title")}
        description={t("meetings.description")}
      >
        <ToggleSwitch
          checked={getSetting("meeting_detection_enabled") ?? true}
          onChange={(enabled) =>
            updateSetting("meeting_detection_enabled", enabled)
          }
          isUpdating={isUpdating("meeting_detection_enabled")}
          label={t("meetings.detection.label")}
          description={t("meetings.detection.description")}
          descriptionMode="inline"
          grouped={true}
        />
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

      <div className="space-y-3">
        <div className="flex items-center gap-3">
          {status?.active ? (
            <Button
              variant="danger"
              disabled={busy || status.finishing}
              onClick={stop}
            >
              <span className="inline-flex items-center gap-2">
                <Square size={14} />
                {status.finishing ? t("meetings.finishing") : t("meetings.stop")}
              </span>
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={busy || !models?.ready}
              onClick={start}
            >
              <span className="inline-flex items-center gap-2">
                <Circle size={14} />
                {t("meetings.start")}
              </span>
            </Button>
          )}
          {status?.active && !status.finishing && (
            <span className="text-sm inline-flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              {t("meetings.recording")} {formatTs(elapsed)}
            </span>
          )}
          {status?.backend && (
            <span className="text-xs text-mid-gray">
              {t("meetings.backend", { backend: status.backend })}
            </span>
          )}
        </div>
        {lag > 15 && (
          <p className="text-xs text-amber-400">
            {t("meetings.behind", { seconds: Math.round(lag) })}
          </p>
        )}
        {error && <p className="text-xs text-red-400">{error}</p>}
        {status?.active && (
          <div className="max-h-96 overflow-y-auto rounded-lg border border-mid-gray/20 p-4">
            {live.length === 0 ? (
              <p className="text-sm text-mid-gray">{t("meetings.waiting")}</p>
            ) : (
              <Transcript utterances={live} nameFor={genericName} />
            )}
            <div ref={liveEndRef} />
          </div>
        )}
      </div>

      <SettingsGroup title={t("meetings.list.title")}>
        {meetings.length === 0 ? (
          <p className="p-4 text-sm text-mid-gray">{t("meetings.list.empty")}</p>
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
