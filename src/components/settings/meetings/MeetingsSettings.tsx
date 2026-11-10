import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  Copy,
  Download,
  FileText,
  Info,
  Loader2,
  Lock,
  MoreHorizontal,
  Pencil,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  commands,
  type Meeting,
  type MeetingSummary,
  type Utterance,
} from "@/bindings";
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

const formatDay = (unix: number) =>
  new Date(unix * 1000).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

const formatTimeOfDay = (unix: number) =>
  new Date(unix * 1000).toLocaleTimeString(undefined, { timeStyle: "short" });

/** The fixed "Reunión 2026-10-09 18:06" part of a meeting title. */
const titlePrefix = (meeting: Meeting) =>
  meeting.name && meeting.title.endsWith(` - ${meeting.name}`)
    ? meeting.title.slice(0, -(meeting.name.length + 3))
    : meeting.title;

const utteranceDomId = (index: number) => `meeting-utterance-${index}`;

// ---- Grouping by date -------------------------------------------------------

interface MeetingGroup {
  key: string;
  label: string;
  items: MeetingSummary[];
}

const DAY_MS = 24 * 3600 * 1000;
const startOfDay = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Buckets meetings (newest first) into Today / Yesterday / This week / month. */
const groupMeetings = (
  meetings: MeetingSummary[],
  t: TFunction,
): MeetingGroup[] => {
  const today = startOfDay(new Date());
  const groups: MeetingGroup[] = [];
  for (const m of meetings) {
    const date = new Date(m.started_at * 1000);
    const day = startOfDay(date);
    let key: string;
    let label: string;
    if (day >= today) {
      key = "today";
      label = t("meetings.groups.today");
    } else if (day >= today - DAY_MS) {
      key = "yesterday";
      label = t("meetings.groups.yesterday");
    } else if (day >= today - 6 * DAY_MS) {
      key = "week";
      label = t("meetings.groups.thisWeek");
    } else {
      key = `${date.getFullYear()}-${date.getMonth()}`;
      label = date.toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      });
    }
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(m);
    else groups.push({ key, label, items: [m] });
  }
  return groups;
};

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

/** After the user scrolls the transcript, don't auto-follow the playhead. */
const AUTOFOLLOW_PAUSE_MS = 4000;

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

interface SpeakerStripProps {
  utterances: Utterance[];
  nameFor: (speaker: number) => string;
  hint: string;
  /** Jump to a speaker's first utterance (its index and start time). */
  onJump: (index: number, start: number) => void;
  onRename: (speaker: number) => void;
}

/** One compact pill per detected speaker, to find and hear each voice. */
const SpeakerStrip: React.FC<SpeakerStripProps> = ({
  utterances,
  nameFor,
  hint,
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
    <div className="flex items-center gap-3 min-w-0">
      <span
        className="inline-flex items-center gap-1 shrink-0 text-[11px] font-medium text-mid-gray uppercase tracking-wide"
        title={hint}
      >
        {t("meetings.detail.speakers")}
        <Info size={12} />
      </span>
      <div className="flex-1 min-w-0 flex gap-1.5 overflow-x-auto pb-1">
        {sorted.map(([speaker, { index, turns }]) => (
          <div
            key={speaker}
            className="group shrink-0 inline-flex items-center rounded-full border border-mid-gray/25 bg-mid-gray/5 hover:bg-mid-gray/15 transition-colors"
          >
            <button
              type="button"
              className="inline-flex items-center gap-1.5 ps-2.5 pe-1.5 py-1 text-xs cursor-pointer"
              title={t("meetings.detail.jumpToSpeaker")}
              onClick={() => onJump(index, utterances[index].start)}
            >
              <span
                className={`size-2 rounded-full bg-current ${speakerColor(speaker)}`}
              />
              <span className="font-medium max-w-[9rem] truncate">
                {nameFor(speaker)}
              </span>
              <span className="text-mid-gray tabular-nums">{turns}</span>
            </button>
            <button
              type="button"
              className="pe-2 ps-0.5 py-1 text-mid-gray opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-logo-primary cursor-pointer"
              title={t("meetings.detail.renameSpeaker")}
              onClick={() => onRename(speaker)}
            >
              <Pencil size={11} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

/** The recording-state icon shown at the end of a list row. */
const AudioBadge: React.FC<{ meeting: MeetingSummary }> = ({ meeting: m }) => {
  const { t } = useTranslation();
  if (!m.audio_available) {
    return (
      <span title={t("meetings.list.audioDeleted")}>
        <VolumeX size={14} className="text-mid-gray/60" />
      </span>
    );
  }
  if (m.keep_audio) {
    return (
      <span
        className="inline-flex items-center text-logo-primary"
        title={t("meetings.list.audioKept")}
      >
        <Volume2 size={14} />
        <Lock size={10} />
      </span>
    );
  }
  return (
    <span
      className="text-logo-primary"
      title={t("meetings.list.audioAvailable", {
        date: formatDate(m.audio_expires_at ?? m.started_at),
      })}
    >
      <Volume2 size={14} />
    </span>
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
  const [menuOpen, setMenuOpen] = useState(false);
  const playerRef = useRef<AudioPlayerHandle>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const lastUserScrollRef = useRef(0);
  const [playhead, setPlayhead] = useState<number | null>(null);

  const groups = useMemo(() => groupMeetings(meetings, t), [meetings, t]);

  const genericName = useCallback(
    (speaker: number) =>
      speaker > 0
        ? t("meetings.speaker", { n: speaker })
        : t("meetings.unknownSpeaker"),
    [t],
  );

  const openMeeting = useCallback(async (id: number) => {
    const res = await commands.getMeeting(id);
    if (res.status === "ok") {
      setSelected(res.data);
      setMenuOpen(false);
    } else setError(res.error);
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

  // Follow the playhead inside the transcript block, unless the user is
  // scrolling it themselves.
  const activeIndex =
    selected && playhead
      ? selected.utterances.findIndex(
          (u) => playhead >= u.start && playhead < u.end,
        )
      : -1;
  useEffect(() => {
    if (activeIndex < 0) return;
    if (Date.now() - lastUserScrollRef.current < AUTOFOLLOW_PAUSE_MS) return;
    document
      .getElementById(utteranceDomId(activeIndex))
      ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [activeIndex]);

  const markUserScroll = () => {
    lastUserScrollRef.current = Date.now();
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

  const copyRawMeeting = async () => {
    if (!selected) return;
    const res = await commands.getMeetingRawTranscript(selected.id);
    if (res.status === "error") {
      setError(t("meetings.detail.rawUnavailable"));
      return;
    }
    if (await copyToClipboard(res.data)) {
      setNotice(t("meetings.detail.copiedRaw"));
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
    setMenuOpen(false);
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
    setMenuOpen(false);
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
    // A deliberate jump: let the view move even if the user scrolled recently.
    lastUserScrollRef.current = 0;
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

  // ---- Detail pane --------------------------------------------------------
  const detailView = selected ? (
    (() => {
      const names = nameFor(selected);
      const speakerCount = new Set(selected.utterances.map((u) => u.speaker))
        .size;
      return (
        <div className="flex-1 min-w-0 min-h-0 flex flex-col rounded-xl border border-mid-gray/20 overflow-hidden">
          {/* Header: compact, always visible */}
          <div className="shrink-0 space-y-2.5 px-5 pt-4 pb-3">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-[11px] text-mid-gray tabular-nums truncate">
                  {titlePrefix(selected)}
                </p>
                {editingTitle !== null ? (
                  <input
                    autoFocus
                    className="w-full bg-transparent border-b border-mid-gray/40 text-xl font-semibold focus:outline-none"
                    placeholder={t("meetings.detail.namePlaceholder")}
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onBlur={saveTitle}
                    onKeyDown={(e) => e.key === "Enter" && saveTitle()}
                  />
                ) : (
                  <button
                    type="button"
                    className={`group inline-flex items-center gap-2 max-w-full text-left text-xl font-semibold cursor-pointer ${
                      selected.name ? "" : "text-mid-gray font-normal italic"
                    }`}
                    title={t("meetings.detail.rename")}
                    onClick={() => setEditingTitle(selected.name)}
                  >
                    <span className="truncate">
                      {selected.name || t("meetings.detail.namePlaceholder")}
                    </span>
                    <Pencil
                      size={14}
                      className="shrink-0 text-mid-gray opacity-0 group-hover:opacity-100"
                    />
                  </button>
                )}
              </div>
              <div className="relative flex items-center gap-1.5 shrink-0">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={copyMeeting}
                  title={t("meetings.detail.copy")}
                >
                  <span className="inline-flex items-center gap-1">
                    <Copy size={14} />
                    {t("meetings.detail.copy")}
                  </span>
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={copyRawMeeting}
                  title={t("meetings.detail.copyRawTitle")}
                >
                  <span className="inline-flex items-center gap-1">
                    <FileText size={14} />
                    {t("meetings.detail.copyRaw")}
                  </span>
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={saveMarkdown}
                  title={t("meetings.detail.save")}
                >
                  <span className="inline-flex items-center gap-1">
                    <Download size={14} />
                    {t("meetings.detail.save")}
                  </span>
                </Button>
                <button
                  type="button"
                  aria-label={t("meetings.detail.more")}
                  title={t("meetings.detail.more")}
                  aria-expanded={menuOpen}
                  className="size-8 inline-flex items-center justify-center rounded-md border border-mid-gray/20 hover:bg-mid-gray/15 cursor-pointer"
                  onClick={() => setMenuOpen((v) => !v)}
                >
                  <MoreHorizontal size={16} />
                </button>
                {menuOpen && (
                  <>
                    <button
                      type="button"
                      aria-hidden="true"
                      tabIndex={-1}
                      className="fixed inset-0 z-10 cursor-default"
                      onClick={() => setMenuOpen(false)}
                    />
                    <div className="absolute right-0 top-full mt-1 z-20 min-w-48 rounded-lg border border-mid-gray/25 bg-background shadow-lg py-1">
                      {selected.audio_available && (
                        <button
                          type="button"
                          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-400 hover:bg-mid-gray/15 cursor-pointer"
                          onClick={deleteAudio}
                        >
                          <VolumeX size={14} />
                          {t("meetings.detail.deleteAudio")}
                        </button>
                      )}
                      <button
                        type="button"
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-400 hover:bg-mid-gray/15 cursor-pointer"
                        onClick={deleteMeeting}
                      >
                        <Trash2 size={14} />
                        {t("meetings.detail.delete")}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-mid-gray">
              <span>{formatDay(selected.started_at)}</span>
              <span>·</span>
              <span className="tabular-nums">
                {formatTimeOfDay(selected.started_at)}
              </span>
              <span>·</span>
              <span className="tabular-nums">
                {formatTs(selected.ended_at - selected.started_at)}
              </span>
              <span>·</span>
              <span>
                {t("meetings.list.speakers", { count: speakerCount })}
              </span>
              <div className="flex-1" />
              {selected.audio_available ? (
                <>
                  {!selected.keep_audio &&
                    selected.audio_expires_at != null && (
                      <span
                        title={t("meetings.detail.audioExpires", {
                          date: formatDate(selected.audio_expires_at),
                        })}
                      >
                        {t("meetings.detail.expiresShort", {
                          date: new Date(
                            selected.audio_expires_at * 1000,
                          ).toLocaleDateString(undefined, {
                            day: "numeric",
                            month: "short",
                          }),
                        })}
                      </span>
                    )}
                  <button
                    type="button"
                    aria-pressed={selected.keep_audio}
                    title={
                      selected.keep_audio
                        ? t("meetings.detail.audioKept")
                        : t("meetings.detail.keepAudio")
                    }
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 cursor-pointer transition-colors ${
                      selected.keep_audio
                        ? "border-logo-primary/50 bg-logo-primary/15 text-logo-primary"
                        : "border-mid-gray/25 hover:bg-mid-gray/15"
                    }`}
                    onClick={() => setKeepAudio(!selected.keep_audio)}
                  >
                    <Lock size={11} />
                    {t("meetings.detail.keepShort")}
                  </button>
                </>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <VolumeX size={12} />
                  {t("meetings.detail.audioDeleted")}
                </span>
              )}
            </div>

            {selected.audio_available && (
              <AudioPlayerGroup>
                <AudioPlayer
                  ref={playerRef}
                  onLoadRequest={loadAudio}
                  onTimeUpdate={setPlayhead}
                  className="rounded-lg bg-mid-gray/10 px-3 py-2"
                />
              </AudioPlayerGroup>
            )}

            <SpeakerStrip
              utterances={selected.utterances}
              nameFor={names}
              hint={
                selected.audio_available
                  ? t("meetings.detail.renameSpeakerHint")
                  : t("meetings.detail.renameSpeakerHintNoAudio")
              }
              onJump={jumpTo}
              onRename={startRenameSpeaker}
            />

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
                    setEditingSpeaker({
                      ...editingSpeaker,
                      name: e.target.value,
                    })
                  }
                  onBlur={saveSpeakerName}
                  onKeyDown={(e) => e.key === "Enter" && saveSpeakerName()}
                />
              </div>
            )}
            {notice && <p className="text-xs text-mid-gray">{notice}</p>}
            {error && <p className="text-xs text-red-400">{error}</p>}
          </div>

          {/* Transcript: scrolls on its own */}
          <div
            ref={transcriptRef}
            className="flex-1 min-h-0 overflow-y-auto border-t border-mid-gray/20 px-5 py-3"
            onWheel={markUserScroll}
            onTouchMove={markUserScroll}
            onPointerDown={markUserScroll}
          >
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
        </div>
      );
    })()
  ) : (
    <div className="flex-1 min-w-0 flex items-center justify-center rounded-xl border border-dashed border-mid-gray/30 p-10 text-sm text-mid-gray text-center">
      {t("meetings.detail.selectPrompt")}
    </div>
  );

  // ---- Master / detail layout -------------------------------------------
  return (
    <div className="flex w-full max-w-6xl h-full min-h-0 gap-4">
      <div className="w-80 shrink-0 min-h-0 flex flex-col gap-3">
        <div className="shrink-0 flex items-center justify-between px-1">
          <h2 className="text-xs font-medium text-mid-gray uppercase tracking-wide">
            {t("meetings.list.title")}
          </h2>
          <details className="relative">
            <summary
              className="list-none cursor-pointer text-mid-gray hover:text-text"
              title={t("meetings.list.info")}
              aria-label={t("meetings.list.info")}
            >
              <Info size={14} />
            </summary>
            <div className="absolute right-0 top-full mt-1 z-20 w-72 space-y-2 rounded-lg border border-mid-gray/25 bg-background p-3 text-xs text-mid-gray shadow-lg">
              <p>{t("meetings.description")}</p>
              <p>{t("meetings.howTo")}</p>
            </div>
          </details>
        </div>

        {job && (
          <div className="shrink-0 rounded-lg border border-mid-gray/20 p-3 flex items-center gap-3">
            <Loader2
              size={16}
              className="shrink-0 animate-spin text-logo-primary"
            />
            <div className="flex-1 min-w-0 space-y-1">
              <p className="text-xs truncate">
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
            <button
              type="button"
              aria-label={t("meetings.diarize.cancel")}
              title={t("meetings.diarize.cancel")}
              className="size-7 shrink-0 inline-flex items-center justify-center rounded-md hover:bg-mid-gray/20 cursor-pointer"
              onClick={cancelJob}
            >
              <X size={14} />
            </button>
          </div>
        )}

        {models && !models.ready && (
          <div className="shrink-0 rounded-lg border border-mid-gray/20 p-3 space-y-2">
            <p className="text-sm font-medium">{t("meetings.models.title")}</p>
            <p className="text-xs text-mid-gray">
              {t("meetings.models.description")}
            </p>
            <Button
              variant="primary"
              size="sm"
              disabled={models.downloading}
              onClick={download}
            >
              {models.downloading
                ? t("meetings.models.downloading", { percent })
                : t("meetings.models.download")}
            </Button>
          </div>
        )}

        {error && !selected && (
          <p className="shrink-0 text-xs text-red-400">{error}</p>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-mid-gray/20">
          {meetings.length === 0 ? (
            <p className="p-4 text-sm text-mid-gray">
              {t("meetings.list.empty")}
            </p>
          ) : (
            groups.map((group) => (
              <section key={group.key}>
                <h3 className="sticky top-0 z-10 flex items-center justify-between bg-background/95 backdrop-blur px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-mid-gray border-b border-mid-gray/10">
                  <span>{group.label}</span>
                  <span className="tabular-nums">{group.items.length}</span>
                </h3>
                {group.items.map((m) => {
                  const isSelected = selected?.id === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      title={m.title}
                      aria-current={isSelected ? "true" : undefined}
                      className={`w-full text-left ps-3.5 pe-4 py-2.5 border-b border-mid-gray/10 border-s-2 cursor-pointer transition-colors ${
                        isSelected
                          ? "bg-logo-primary/15 border-s-logo-primary"
                          : "border-s-transparent hover:bg-mid-gray/10"
                      }`}
                      onClick={() => openMeeting(m.id)}
                    >
                      <p
                        className={`text-sm truncate ${
                          m.name
                            ? "font-medium"
                            : "font-normal italic text-mid-gray"
                        }`}
                      >
                        {m.name || t("meetings.list.unnamed")}
                      </p>
                      <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-mid-gray">
                        <span className="truncate tabular-nums">
                          {formatTimeOfDay(m.started_at)} ·{" "}
                          {formatTs(m.ended_at - m.started_at)} ·{" "}
                          {t("meetings.list.speakers", {
                            count: m.speaker_count,
                          })}
                        </span>
                        <span className="shrink-0">
                          <AudioBadge meeting={m} />
                        </span>
                      </div>
                      {m.preview && (
                        <p className="mt-0.5 text-xs text-mid-gray/80 truncate">
                          {m.preview}
                        </p>
                      )}
                    </button>
                  );
                })}
              </section>
            ))
          )}
        </div>
      </div>
      {detailView}
    </div>
  );
};
