import React, { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import {
  Check,
  Copy,
  FolderOpen,
  Loader2,
  RotateCcw,
  Search,
  Star,
  Trash2,
  Users,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  commands,
  events,
  type HistoryEntry,
  type HistoryUpdatePayload,
} from "@/bindings";
import { useOsType } from "@/hooks/useOsType";
import { formatDate, formatDateTime } from "@/utils/dateFormat";
import { AudioPlayer, AudioPlayerGroup } from "../../ui/AudioPlayer";
import { Button } from "../../ui/Button";
import { copyToClipboard } from "./clipboard";
import { useMeetingStore } from "../../../stores/meetingStore";

const IconButton: React.FC<{
  onClick: () => void;
  title: string;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}> = ({ onClick, title, disabled, active, children }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`p-1.5 rounded-md flex items-center justify-center transition-colors cursor-pointer disabled:cursor-not-allowed disabled:text-text/20 ${
      active
        ? "text-logo-primary hover:text-logo-primary/80"
        : "text-text/50 hover:text-logo-primary"
    }`}
    title={title}
  >
    {children}
  </button>
);

const PAGE_SIZE = 30;

/** Turns an entry's recording into a speaker-labeled meeting, or opens it. */
const MeetingButton: React.FC<{ historyId: number; disabled?: boolean }> = ({
  historyId,
  disabled,
}) => {
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
          <Loader2 width={16} height={16} className="animate-spin" />
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
        <Users width={16} height={16} />
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
      <Users width={16} height={16} />
    </IconButton>
  );
};

interface OpenRecordingsButtonProps {
  onClick: () => void;
  label: string;
}

const OpenRecordingsButton: React.FC<OpenRecordingsButtonProps> = ({
  onClick,
  label,
}) => (
  <Button
    onClick={onClick}
    variant="secondary"
    size="sm"
    className="flex items-center gap-2"
    title={label}
  >
    <FolderOpen className="w-4 h-4" />
    <span>{label}</span>
  </Button>
);

export const HistorySettings: React.FC = () => {
  const { t, i18n } = useTranslation();
  const osType = useOsType();
  const [query, setQuery] = useState("");
  const [onlySaved, setOnlySaved] = useState(false);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const entriesRef = useRef<HistoryEntry[]>([]);
  const loadingRef = useRef(false);

  // Keep ref in sync for use in IntersectionObserver callback
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  const loadPage = useCallback(async (cursor?: number) => {
    const isFirstPage = cursor === undefined;
    if (!isFirstPage && loadingRef.current) return;
    loadingRef.current = true;

    if (isFirstPage) setLoading(true);

    try {
      const result = await commands.getHistoryEntries(
        cursor ?? null,
        PAGE_SIZE,
      );
      if (result.status === "ok") {
        const { entries: newEntries, has_more } = result.data;
        setEntries((prev) =>
          isFirstPage ? newEntries : [...prev, ...newEntries],
        );
        setHasMore(has_more);
      }
    } catch (error) {
      console.error("Failed to load history entries:", error);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }, []);

  // Initial load
  useEffect(() => {
    loadPage();
  }, [loadPage]);

  // Infinite scroll via IntersectionObserver
  useEffect(() => {
    if (loading) return;

    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;

    const observer = new IntersectionObserver(
      (observerEntries) => {
        const first = observerEntries[0];
        if (first.isIntersecting) {
          const lastEntry = entriesRef.current[entriesRef.current.length - 1];
          if (lastEntry) {
            loadPage(lastEntry.id);
          }
        }
      },
      { threshold: 0 },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loading, hasMore, loadPage]);

  // Listen for new entries added from the transcription pipeline
  useEffect(() => {
    const unlisten = events.historyUpdatePayload.listen((event) => {
      const payload: HistoryUpdatePayload = event.payload;
      if (payload.action === "added") {
        setEntries((prev) => [payload.entry, ...prev]);
      } else if (payload.action === "updated") {
        setEntries((prev) =>
          prev.map((e) => (e.id === payload.entry.id ? payload.entry : e)),
        );
      }
      // "deleted" and "toggled" are handled by optimistic updates only,
      // so we intentionally ignore them here to avoid double-mutation.
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const toggleSaved = async (id: number) => {
    // Optimistic update
    setEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, saved: !e.saved } : e)),
    );
    try {
      const result = await commands.toggleHistoryEntrySaved(id);
      if (result.status !== "ok") {
        // Revert on failure
        setEntries((prev) =>
          prev.map((e) => (e.id === id ? { ...e, saved: !e.saved } : e)),
        );
      }
    } catch (error) {
      console.error("Failed to toggle saved status:", error);
      // Revert on failure
      setEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, saved: !e.saved } : e)),
      );
    }
  };

  const getAudioUrl = useCallback(
    async (fileName: string) => {
      try {
        const result = await commands.getAudioFilePath(fileName);
        if (result.status === "ok") {
          if (osType === "linux") {
            const fileData = await readFile(result.data);
            const blob = new Blob([fileData], { type: "audio/wav" });
            return URL.createObjectURL(blob);
          }
          return convertFileSrc(result.data, "asset");
        }
        return null;
      } catch (error) {
        console.error("Failed to get audio file path:", error);
        return null;
      }
    },
    [osType],
  );

  const deleteAudioEntry = async (id: number) => {
    // Optimistically remove
    setEntries((prev) => prev.filter((e) => e.id !== id));
    try {
      const result = await commands.deleteHistoryEntry(id);
      if (result.status !== "ok") {
        // Reload on failure
        loadPage();
      }
    } catch (error) {
      console.error("Failed to delete entry:", error);
      loadPage();
    }
  };

  const retryHistoryEntry = async (id: number) => {
    const result = await commands.retryHistoryEntryTranscription(id);
    if (result.status !== "ok") {
      throw new Error(String(result.error));
    }
  };

  const openRecordingsFolder = async () => {
    try {
      const result = await commands.openRecordingsFolder();
      if (result.status !== "ok") {
        throw new Error(String(result.error));
      }
    } catch (error) {
      console.error("Failed to open recordings folder:", error);
    }
  };

  // Search and the favorites filter run over the loaded pages; infinite
  // scroll keeps loading older pages while the sentinel stays in view.
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleEntries = entries.filter((entry) => {
    if (onlySaved && !entry.saved) return false;
    if (!normalizedQuery) return true;
    return [entry.transcription_text, entry.post_processed_text, entry.title]
      .filter((text): text is string => typeof text === "string")
      .some((text) => text.toLocaleLowerCase().includes(normalizedQuery));
  });
  const dayLabels = {
    today: t("settings.history.today"),
    yesterday: t("settings.history.yesterday"),
  };
  const groups = groupByDay(visibleEntries, (unix) =>
    dayLabel(unix, i18n.language, dayLabels),
  );

  let content: React.ReactNode;

  if (loading) {
    content = (
      <div className="px-4 py-6 text-center text-text/60 rounded-xl border border-mid-gray/20">
        {t("settings.history.loading")}
      </div>
    );
  } else if (entries.length === 0) {
    content = (
      <div className="px-4 py-6 text-center text-text/60 rounded-xl border border-mid-gray/20">
        {t("settings.history.empty")}
      </div>
    );
  } else {
    content = (
      <>
        {groups.length === 0 ? (
          <div className="px-4 py-6 text-center text-text/60 rounded-xl border border-dashed border-mid-gray/30">
            {t("settings.history.noMatches")}
          </div>
        ) : (
          <AudioPlayerGroup>
            <div className="space-y-5">
              {groups.map((group) => (
                <section key={group.key} className="space-y-2">
                  <h3 className="px-1 text-xs font-semibold uppercase tracking-wide text-mid-gray">
                    {group.label}
                  </h3>
                  <div className="rounded-xl border border-mid-gray/20 divide-y divide-mid-gray/15 overflow-visible">
                    {group.items.map((entry) => (
                      <HistoryEntryComponent
                        key={entry.id}
                        entry={entry}
                        onToggleSaved={() => toggleSaved(entry.id)}
                        onCopyText={() =>
                          copyToClipboard(entry.transcription_text)
                        }
                        getAudioUrl={getAudioUrl}
                        deleteAudio={deleteAudioEntry}
                        retryTranscription={retryHistoryEntry}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </AudioPlayerGroup>
        )}
        {/* Sentinel for infinite scroll */}
        <div ref={sentinelRef} className="h-1" />
      </>
    );
  }

  const chipClass = (active: boolean) =>
    `h-8 px-3 rounded-full text-sm font-medium border transition-colors cursor-pointer ${
      active
        ? "bg-text text-background border-text"
        : "border-mid-gray/30 text-text/80 hover:bg-mid-gray/10"
    }`;

  return (
    <div className="max-w-3xl w-full mx-auto space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 flex-1 min-w-56 h-9 px-3 rounded-lg border border-mid-gray/30 bg-mid-gray/5 focus-within:border-logo-primary">
          <Search className="w-4 h-4 text-mid-gray shrink-0" />
          <span className="sr-only">{t("settings.history.search")}</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("settings.history.search")}
            className="flex-1 min-w-0 bg-transparent text-sm focus:outline-none"
          />
        </label>
        <div
          role="group"
          aria-label={t("settings.history.filter")}
          className="flex gap-1"
        >
          <button
            type="button"
            aria-pressed={!onlySaved}
            className={chipClass(!onlySaved)}
            onClick={() => setOnlySaved(false)}
          >
            {t("settings.history.filterAll")}
          </button>
          <button
            type="button"
            aria-pressed={onlySaved}
            className={chipClass(onlySaved)}
            onClick={() => setOnlySaved(true)}
          >
            {t("settings.history.filterSaved")}
          </button>
        </div>
        <OpenRecordingsButton
          onClick={openRecordingsFolder}
          label={t("settings.history.openFolder")}
        />
      </div>
      {content}
    </div>
  );
};

interface DayGroup {
  key: string;
  label: string;
  items: HistoryEntry[];
}

/** Groups entries (already newest first) by local calendar day. */
const groupByDay = (
  entries: HistoryEntry[],
  labelFor: (unix: number) => string,
): DayGroup[] => {
  const groups: DayGroup[] = [];
  for (const entry of entries) {
    const d = new Date(Number(entry.timestamp) * 1000);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.items.push(entry);
    } else {
      groups.push({
        key,
        label: labelFor(Number(entry.timestamp)),
        items: [entry],
      });
    }
  }
  return groups;
};

const dayLabel = (
  unix: number,
  locale: string,
  labels: { today: string; yesterday: string },
): string => {
  const date = new Date(unix * 1000);
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round(
    (startOfDay(new Date()) - startOfDay(date)) / 86_400_000,
  );
  if (diffDays === 0) return labels.today;
  if (diffDays === 1) return labels.yesterday;
  return formatDate(String(unix), locale);
};

interface HistoryEntryProps {
  entry: HistoryEntry;
  onToggleSaved: () => void;
  onCopyText: () => Promise<boolean>;
  getAudioUrl: (fileName: string) => Promise<string | null>;
  deleteAudio: (id: number) => Promise<void>;
  retryTranscription: (id: number) => Promise<void>;
}

const HistoryEntryComponent: React.FC<HistoryEntryProps> = ({
  entry,
  onToggleSaved,
  onCopyText,
  getAudioUrl,
  deleteAudio,
  retryTranscription,
}) => {
  const { t, i18n } = useTranslation();
  const [showCopied, setShowCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const hasTranscription = entry.transcription_text.trim().length > 0;

  const handleLoadAudio = useCallback(
    () => getAudioUrl(entry.file_name),
    [getAudioUrl, entry.file_name],
  );

  const handleCopyText = async () => {
    if (!hasTranscription) {
      return;
    }

    const copied = await onCopyText();
    if (!copied) {
      toast.error(t("settings.history.copyError"));
      return;
    }

    setShowCopied(true);
    setTimeout(() => setShowCopied(false), 2000);
  };

  const handleDeleteEntry = async () => {
    try {
      await deleteAudio(entry.id);
    } catch (error) {
      console.error("Failed to delete entry:", error);
      toast.error(t("settings.history.deleteError"));
    }
  };

  const handleRetranscribe = async () => {
    try {
      setRetrying(true);
      await retryTranscription(entry.id);
    } catch (error) {
      console.error("Failed to re-transcribe:", error);
      toast.error(t("settings.history.retranscribeError"));
    } finally {
      setRetrying(false);
    }
  };

  const formattedDate = formatDateTime(String(entry.timestamp), i18n.language);
  const formattedTime = new Intl.DateTimeFormat(i18n.language, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(Number(entry.timestamp) * 1000));

  return (
    <div className="group px-4 py-3 flex flex-col gap-2 transition-colors hover:bg-mid-gray/5">
      <div className="flex justify-between items-center">
        <p
          className="text-xs font-semibold tabular-nums text-mid-gray"
          title={formattedDate}
        >
          {formattedTime}
        </p>
        <div className="flex items-center opacity-60 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <IconButton
            onClick={handleCopyText}
            disabled={!hasTranscription || retrying}
            title={t("settings.history.copyToClipboard")}
          >
            {showCopied ? (
              <Check width={16} height={16} />
            ) : (
              <Copy width={16} height={16} />
            )}
          </IconButton>
          <IconButton
            onClick={onToggleSaved}
            disabled={retrying}
            active={entry.saved}
            title={
              entry.saved
                ? t("settings.history.unsave")
                : t("settings.history.save")
            }
          >
            <Star
              width={16}
              height={16}
              fill={entry.saved ? "currentColor" : "none"}
            />
          </IconButton>
          <MeetingButton historyId={entry.id} disabled={retrying} />
          <IconButton
            onClick={handleRetranscribe}
            disabled={retrying}
            title={t("settings.history.retranscribe")}
          >
            <RotateCcw
              width={16}
              height={16}
              style={
                retrying
                  ? { animation: "spin 1s linear infinite reverse" }
                  : undefined
              }
            />
          </IconButton>
          <IconButton
            onClick={handleDeleteEntry}
            disabled={retrying}
            title={t("settings.history.delete")}
          >
            <Trash2 width={16} height={16} />
          </IconButton>
        </div>
      </div>

      <p
        className={`text-sm leading-relaxed pb-1 ${
          retrying
            ? ""
            : hasTranscription
              ? "text-text/90 select-text cursor-text whitespace-pre-wrap break-words"
              : "text-text/40"
        }`}
        style={
          retrying
            ? { animation: "transcribe-pulse 3s ease-in-out infinite" }
            : undefined
        }
      >
        {retrying && (
          <style>{`
            @keyframes transcribe-pulse {
              0%, 100% { color: color-mix(in srgb, var(--color-text) 40%, transparent); }
              50% { color: color-mix(in srgb, var(--color-text) 90%, transparent); }
            }
          `}</style>
        )}
        {retrying
          ? t("settings.history.transcribing")
          : hasTranscription
            ? entry.transcription_text
            : t("settings.history.transcriptionFailed")}
      </p>

      <AudioPlayer onLoadRequest={handleLoadAudio} className="w-full" />
    </div>
  );
};
