import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  ArrowLeft,
  Copy,
  Download,
  Loader2,
  Lock,
  Pencil,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { commands, type Meeting, type Utterance } from "@/bindings";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { Button } from "../../ui/Button";
import {
  AudioPlayer,
  AudioPlayerGroup,
  type AudioPlayerHandle,
} from "../../ui/AudioPlayer";
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

/** The fixed "Reunión 2026-10-09 18:06" part of a meeting title. */
const titlePrefix = (meeting: Meeting) =>
  meeting.name && meeting.title.endsWith(` - ${meeting.name}`)
    ? meeting.title.slice(0, -(meeting.name.length + 3))
    : meeting.title;

const utteranceDomId = (index: number) => `meeting-utterance-${index}`;

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

// Accent for the utterance under the playhead, matching the speaker color.
const SPEAKER_BORDERS = [
  "border-sky-400",
  "border-emerald-400",
  "border-amber-400",
  "border-fuchsia-400",
  "border-rose-400",
  "border-lime-400",
  "border-cyan-400",
  "border-orange-400",
];
const speakerBorder = (speaker: number) =>
  speaker > 0
    ? SPEAKER_BORDERS[(speaker - 1) % SPEAKER_BORDERS.length]
    : "border-mid-gray";

/** Start a touch early so the first syllable isn't clipped. */
const SEEK_LEAD_SECS = 0.3;

interface TranscriptProps {
  utterances: Utterance[];
  nameFor: (speaker: number) => string;
  onSpeakerClick?: (speaker: number) => void;
  onSeek?: (seconds: number) => void;
  /** Playhead position; the utterance containing it is highlighted. */
  activeTime?: number | null;
}

const Transcript: React.FC<TranscriptProps> = ({
  utterances,
  nameFor,
  onSpeakerClick,
  onSeek,
  activeTime,
}) => {
  const { t } = useTranslation();
  const seek = (start: number) => onSeek?.(Math.max(0, start - SEEK_LEAD_SECS));

  return (
    <div className="space-y-1">
      {utterances.map((u, i) => {
        const active =
          activeTime != null && activeTime >= u.start && activeTime < u.end;
        return (
          <div
            key={`${u.start}-${i}`}
            id={utteranceDomId(i)}
            className={`border-l-2 pl-2 py-1 rounded-r transition-colors ${
              active
                ? `${speakerBorder(u.speaker)} bg-mid-gray/10`
                : "border-transparent"
            } ${u.provisional ? "opacity-60" : ""}`}
          >
            <div className="flex items-baseline gap-2 text-xs">
              {onSeek ? (
                <button
                  type="button"
                  className="text-mid-gray tabular-nums hover:text-logo-primary hover:underline cursor-pointer"
                  title={t("meetings.detail.playFrom")}
                  onClick={() => seek(u.start)}
                >
                  {formatTs(u.start)}
                </button>
              ) : (
                <span className="text-mid-gray tabular-nums">
                  {formatTs(u.start)}
                </span>
              )}
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
            <p
              className={`text-sm leading-relaxed ${
                onSeek ? "cursor-pointer hover:text-text" : ""
              }`}
              title={onSeek ? t("meetings.detail.playFrom") : undefined}
              onClick={() => {
                // Let the user select text to copy without jumping the audio.
                if (!onSeek || window.getSelection()?.toString()) return;
                seek(u.start);
              }}
            >
              {u.text}
            </p>
          </div>
        );
      })}
    </div>
  );
};

interface SpeakerGridProps {
  utterances: Utterance[];
  nameFor: (speaker: number) => string;
  /** Jump to a speaker's first utterance (its index and start time). */
  onJump: (index: number, start: number) => void;
  onRename: (speaker: number) => void;
}

/** One chip per detected speaker, to find and hear each voice quickly. */
const SpeakerGrid: React.FC<SpeakerGridProps> = ({
  utterances,
  nameFor,
  onJump,
  onRename,
}) => {
  const { t } = useTranslation();
  const speakers = new Map<number, { index: number; turns: number }>();
  utterances.forEach((u, index) => {
    const seen = speakers.get(u.speaker);
    if (seen) seen.turns += 1;
    else speakers.set(u.speaker, { index, turns: 1 });
  });
  // Known speakers by id; the unknown speaker (0) last.
  const sorted = [...speakers.entries()].sort(([a], [b]) =>
    a === 0 ? 1 : b === 0 ? -1 : a - b,
  );
  if (sorted.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-mid-gray uppercase tracking-wide">
        {t("meetings.detail.speakers")}
      </p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2">
        {sorted.map(([speaker, { index, turns }]) => {
          const start = utterances[index].start;
          return (
            <div
              key={speaker}
              className={`flex items-center rounded border border-mid-gray/20 border-l-2 hover:bg-mid-gray/10 ${speakerBorder(speaker)}`}
            >
              <button
                type="button"
                className="flex-1 min-w-0 text-left px-2 py-1.5"
                title={t("meetings.detail.jumpToSpeaker")}
                onClick={() => onJump(index, start)}
              >
                <span
                  className={`block text-sm font-semibold truncate ${speakerColor(speaker)}`}
                >
                  {nameFor(speaker)}
                </span>
                <span className="block text-xs text-mid-gray tabular-nums">
                  {formatTs(start)} ·{" "}
                  {t("meetings.detail.turns", { count: turns })}
                </span>
              </button>
              <button
                type="button"
                className="p-2 text-mid-gray hover:text-logo-primary"
                title={t("meetings.detail.renameSpeaker")}
                onClick={() => onRename(speaker)}
              >
                <Pencil size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};

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
  const playerRef = useRef<AudioPlayerHandle>(null);
  const [playhead, setPlayhead] = useState<number | null>(null);

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
    const res = await commands.renameMeeting(selected.id, editingTitle.trim());
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

  const setKeepAudio = async (keep: boolean) => {
    if (!selected) return;
    const res = await commands.setMeetingKeepAudio(selected.id, keep);
    if (res.status === "error") setError(res.error);
    openMeeting(selected.id);
    refreshList();
  };

  const deleteAudio = async () => {
    if (!selected || !window.confirm(t("meetings.detail.confirmDeleteAudio"))) {
      return;
    }
    const res = await commands.deleteMeetingAudio(selected.id);
    if (res.status === "error") setError(res.error);
    setPlayhead(null);
    openMeeting(selected.id);
    refreshList();
  };

  const startRenameSpeaker = (speaker: number) => {
    if (!selected) return;
    setEditingSpeaker({
      speaker,
      name: selected.speaker_names[String(speaker)] ?? "",
    });
  };

  const jumpTo = (index: number, start: number) => {
    document
      .getElementById(utteranceDomId(index))
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (selected?.audio_available) {
      playerRef.current?.seekTo(Math.max(0, start - SEEK_LEAD_SECS));
    }
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
          <div className="flex items-baseline gap-2 text-lg font-semibold">
            <span className="shrink-0">{titlePrefix(selected)} -</span>
            {editingTitle !== null ? (
              <input
                autoFocus
                className="flex-1 min-w-0 bg-transparent border-b border-mid-gray/40 focus:outline-none"
                placeholder={t("meetings.detail.namePlaceholder")}
                value={editingTitle}
                onChange={(e) => setEditingTitle(e.target.value)}
                onBlur={saveTitle}
                onKeyDown={(e) => e.key === "Enter" && saveTitle()}
              />
            ) : (
              <button
                type="button"
                className={`min-w-0 text-left hover:underline ${
                  selected.name ? "" : "text-mid-gray font-normal italic"
                }`}
                title={t("meetings.detail.rename")}
                onClick={() => setEditingTitle(selected.name)}
              >
                {selected.name || t("meetings.detail.namePlaceholder")}
              </button>
            )}
          </div>
          <p className="text-xs text-mid-gray">
            {formatDate(selected.started_at)} ·{" "}
            {formatTs(selected.ended_at - selected.started_at)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {selected.audio_available ? (
            <AudioPlayerGroup>
              <AudioPlayer
                ref={playerRef}
                onLoadRequest={loadAudio}
                onTimeUpdate={setPlayhead}
                className="flex-1 min-w-48"
              />
            </AudioPlayerGroup>
          ) : (
            <p className="flex-1 min-w-48 inline-flex items-center gap-2 text-sm text-mid-gray">
              <VolumeX size={14} />
              {t("meetings.detail.audioDeleted")}
            </p>
          )}
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
          {selected.audio_available && (
            <Button variant="danger-ghost" size="sm" onClick={deleteAudio}>
              <span className="inline-flex items-center gap-1">
                <VolumeX size={14} />
                {t("meetings.detail.deleteAudio")}
              </span>
            </Button>
          )}
          <Button variant="danger-ghost" size="sm" onClick={deleteMeeting}>
            <span className="inline-flex items-center gap-1">
              <Trash2 size={14} />
              {t("meetings.detail.delete")}
            </span>
          </Button>
        </div>
        {selected.audio_available && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="accent-logo-primary"
                checked={selected.keep_audio}
                onChange={(e) => setKeepAudio(e.target.checked)}
              />
              {t("meetings.detail.keepAudio")}
            </label>
            <span className="text-mid-gray">
              {selected.audio_expires_at != null
                ? t("meetings.detail.audioExpires", {
                    date: formatDate(selected.audio_expires_at),
                  })
                : t("meetings.detail.audioKept")}
            </span>
          </div>
        )}
        {notice && <p className="text-xs text-mid-gray">{notice}</p>}
        {error && <p className="text-xs text-red-400">{error}</p>}
        <SpeakerGrid
          utterances={selected.utterances}
          nameFor={names}
          onJump={jumpTo}
          onRename={startRenameSpeaker}
        />
        <p className="text-xs text-mid-gray">
          {selected.audio_available
            ? t("meetings.detail.renameSpeakerHint")
            : t("meetings.detail.renameSpeakerHintNoAudio")}
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
          onSeek={
            selected.audio_available
              ? (seconds) => playerRef.current?.seekTo(seconds)
              : undefined
          }
          activeTime={playhead || null}
          onSpeakerClick={startRenameSpeaker}
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
                <span className="inline-flex items-center gap-2 shrink-0 text-xs text-mid-gray">
                  {formatTs(m.ended_at - m.started_at)} ·{" "}
                  {t("meetings.list.speakers", { count: m.speaker_count })}
                  {!m.audio_available ? (
                    <span title={t("meetings.list.audioDeleted")}>
                      <VolumeX size={14} className="text-mid-gray/60" />
                    </span>
                  ) : m.keep_audio ? (
                    <span
                      className="inline-flex items-center text-logo-primary"
                      title={t("meetings.list.audioKept")}
                    >
                      <Volume2 size={14} />
                      <Lock size={10} />
                    </span>
                  ) : (
                    <span
                      className="text-logo-primary"
                      title={t("meetings.list.audioAvailable", {
                        date: formatDate(m.audio_expires_at ?? m.started_at),
                      })}
                    >
                      <Volume2 size={14} />
                    </span>
                  )}
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
