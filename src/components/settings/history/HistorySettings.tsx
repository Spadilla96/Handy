import React, { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import { Mic, Search, Star, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  commands,
  events,
  type HistoryEntry,
  type HistoryUpdatePayload,
} from "@/bindings";
import { useOsType } from "@/hooks/useOsType";
import { formatDate } from "@/utils/dateFormat";
import { AudioPlayerGroup } from "../../ui/AudioPlayer";
import { copyToClipboard } from "./clipboard";
import { HistoryDetail, type RetranscribeOptions } from "./HistoryDetail";
import { useMeetingStore } from "../../../stores/meetingStore";

const PAGE_SIZE = 30;

type Filter = "all" | "saved" | "meetings";

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

interface HistoryRowProps {
  entry: HistoryEntry;
  selected: boolean;
  isMeeting: boolean;
  locale: string;
  emptyLabel: string;
  onSelect: () => void;
}

const HistoryRow: React.FC<HistoryRowProps> = ({
  entry,
  selected,
  isMeeting,
  locale,
  emptyLabel,
  onSelect,
}) => {
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(Number(entry.timestamp) * 1000));
  const text = entry.transcription_text.trim();

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={`w-full text-start ps-3.5 pe-4 py-2.5 border-b border-mid-gray/10 border-s-2 cursor-pointer transition-colors ${
        selected
          ? "bg-logo-primary/15 border-s-logo-primary"
          : "border-s-transparent hover:bg-mid-gray/10"
      }`}
    >
      <div className="flex items-center gap-2 text-xs text-mid-gray">
        <span className="font-semibold tabular-nums">{time}</span>
        <span className="flex-1" />
        {isMeeting && (
          <Users size={12} className="text-logo-primary" aria-hidden="true" />
        )}
        {entry.saved && (
          <Star
            size={12}
            className="text-logo-primary"
            fill="currentColor"
            aria-hidden="true"
          />
        )}
      </div>
      <p
        className={`mt-0.5 text-sm leading-snug line-clamp-2 break-words ${
          text ? "text-text/90" : "italic text-mid-gray"
        }`}
      >
        {text || emptyLabel}
      </p>
    </button>
  );
};

export const HistorySettings: React.FC = () => {
  const { t, i18n } = useTranslation();
  const osType = useOsType();
  const meetingByHistory = useMeetingStore((s) => s.meetingByHistory);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
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

  // Infinite scroll via IntersectionObserver (the list is its own scroller).
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
  }, [loading, hasMore, loadPage, entries.length]);

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
    const flip = () =>
      setEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, saved: !e.saved } : e)),
      );
    flip(); // Optimistic update
    try {
      const result = await commands.toggleHistoryEntrySaved(id);
      if (result.status !== "ok") flip();
    } catch (error) {
      console.error("Failed to toggle saved status:", error);
      flip();
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

  const retryHistoryEntry = async (
    id: number,
    options?: RetranscribeOptions,
  ) => {
    const result = await commands.retryHistoryEntryTranscription(
      id,
      options?.model ?? null,
      options?.enhance ?? null,
    );
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

  // Search and filters run over the loaded pages; infinite scroll keeps loading
  // older pages while the sentinel stays in view.
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleEntries = entries.filter((entry) => {
    if (filter === "saved" && !entry.saved) return false;
    if (filter === "meetings" && meetingByHistory[entry.id] === undefined) {
      return false;
    }
    if (!normalizedQuery) return true;
    return [entry.transcription_text, entry.post_processed_text, entry.title]
      .filter((text): text is string => typeof text === "string")
      .some((text) => text.toLocaleLowerCase().includes(normalizedQuery));
  });

  const deleteEntry = async (id: number) => {
    // Move the selection to the neighbour before removing the entry.
    if (selectedEntry?.id === id) {
      const idx = visibleEntries.findIndex((e) => e.id === id);
      const next = visibleEntries[idx + 1] ?? visibleEntries[idx - 1];
      setSelectedId(next ? next.id : null);
    }
    setEntries((prev) => prev.filter((e) => e.id !== id)); // Optimistic
    try {
      const result = await commands.deleteHistoryEntry(id);
      if (result.status !== "ok") loadPage();
    } catch (error) {
      console.error("Failed to delete entry:", error);
      loadPage();
      throw error;
    }
  };

  // The selected entry, falling back to the newest visible one.
  const selectedEntry =
    visibleEntries.find((e) => e.id === selectedId) ?? visibleEntries[0];

  const dayLabels = {
    today: t("settings.history.today"),
    yesterday: t("settings.history.yesterday"),
  };
  const groups = groupByDay(visibleEntries, (unix) =>
    dayLabel(unix, i18n.language, dayLabels),
  );

  const chipClass = (active: boolean) =>
    `h-7 px-3 rounded-full text-xs font-medium border transition-colors cursor-pointer ${
      active
        ? "bg-text text-background border-text"
        : "border-mid-gray/30 text-text/80 hover:bg-mid-gray/10"
    }`;

  const filters: { id: Filter; label: string }[] = [
    { id: "all", label: t("settings.history.filterAll") },
    { id: "saved", label: t("settings.history.filterSaved") },
    { id: "meetings", label: t("settings.history.filterMeetings") },
  ];

  let list: React.ReactNode;
  if (loading) {
    list = (
      <div className="space-y-2 p-3" aria-busy="true">
        {Array.from({ length: 6 }, (_, i) => (
          <div
            key={i}
            className="h-12 rounded-md bg-mid-gray/10 animate-pulse"
          />
        ))}
      </div>
    );
  } else if (entries.length === 0) {
    list = (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-text/60">
        <Mic size={20} className="text-mid-gray" aria-hidden="true" />
        {t("settings.history.empty")}
      </div>
    );
  } else if (groups.length === 0) {
    list = (
      <div className="m-3 rounded-lg border border-dashed border-mid-gray/30 px-4 py-6 text-center text-sm text-text/60">
        {t("settings.history.noMatches")}
      </div>
    );
  } else {
    list = groups.map((group) => (
      <section key={group.key}>
        <div className="sticky top-0 z-10 flex items-center justify-between bg-background/95 backdrop-blur px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-mid-gray border-b border-mid-gray/10">
          <span>{group.label}</span>
          <span className="tabular-nums">{group.items.length}</span>
        </div>
        {group.items.map((entry) => (
          <HistoryRow
            key={entry.id}
            entry={entry}
            selected={entry.id === selectedEntry?.id}
            isMeeting={meetingByHistory[entry.id] !== undefined}
            locale={i18n.language}
            emptyLabel={t("settings.history.transcriptionFailed")}
            onSelect={() => setSelectedId(entry.id)}
          />
        ))}
      </section>
    ));
  }

  return (
    <div className="flex w-full max-w-6xl h-full min-h-0 gap-4">
      <div className="w-80 shrink-0 min-h-0 flex flex-col gap-3">
        <label className="flex items-center gap-2 h-9 px-3 rounded-lg border border-mid-gray/30 bg-mid-gray/5 focus-within:border-logo-primary">
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
          className="flex flex-wrap gap-1"
        >
          {filters.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              className={chipClass(filter === f.id)}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-mid-gray/20">
          {list}
          {/* Sentinel for infinite scroll */}
          <div ref={sentinelRef} className="h-1" />
        </div>
      </div>

      <AudioPlayerGroup>
        {selectedEntry ? (
          <HistoryDetail
            key={selectedEntry.id}
            entry={selectedEntry}
            onToggleSaved={() => toggleSaved(selectedEntry.id)}
            onCopyText={() => copyToClipboard(selectedEntry.transcription_text)}
            getAudioUrl={getAudioUrl}
            onDelete={deleteEntry}
            onRetranscribe={retryHistoryEntry}
            onOpenFolder={openRecordingsFolder}
          />
        ) : (
          <div className="flex-1 min-w-0 flex items-center justify-center rounded-xl border border-dashed border-mid-gray/30 text-sm text-mid-gray">
            {t("settings.history.selectEntry")}
          </div>
        )}
      </AudioPlayerGroup>
    </div>
  );
};
