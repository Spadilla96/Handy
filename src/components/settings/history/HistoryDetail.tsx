import React, { useCallback, useEffect, useState } from "react";
import {
  Check,
  Copy,
  FolderOpen,
  MoreHorizontal,
  RotateCcw,
  Star,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { HistoryEntry } from "@/bindings";
import { formatDateTime } from "@/utils/dateFormat";
import { AudioPlayer } from "../../ui/AudioPlayer";
import { IconButton, MeetingButton } from "./HistoryActions";

interface HistoryDetailProps {
  entry: HistoryEntry;
  onToggleSaved: () => void;
  onCopyText: () => Promise<boolean>;
  getAudioUrl: (fileName: string) => Promise<string | null>;
  onDelete: (id: number) => Promise<void>;
  onRetranscribe: (id: number) => Promise<void>;
  onOpenFolder: () => void;
}

const countWords = (text: string) => {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
};

export const HistoryDetail: React.FC<HistoryDetailProps> = ({
  entry,
  onToggleSaved,
  onCopyText,
  getAudioUrl,
  onDelete,
  onRetranscribe,
  onOpenFolder,
}) => {
  const { t, i18n } = useTranslation();
  const [showCopied, setShowCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // A different entry starts with a clean slate.
  useEffect(() => {
    setMenuOpen(false);
    setConfirmDelete(false);
    setShowCopied(false);
  }, [entry.id]);

  const text = entry.transcription_text;
  const hasTranscription = text.trim().length > 0;
  const words = countWords(text);

  const handleLoadAudio = useCallback(
    () => getAudioUrl(entry.file_name),
    [getAudioUrl, entry.file_name],
  );

  const handleCopy = async () => {
    if (!hasTranscription) return;
    const copied = await onCopyText();
    if (!copied) {
      toast.error(t("settings.history.copyError"));
      return;
    }
    setShowCopied(true);
    setTimeout(() => setShowCopied(false), 2000);
  };

  const handleRetranscribe = async () => {
    try {
      setRetrying(true);
      await onRetranscribe(entry.id);
    } catch (error) {
      console.error("Failed to re-transcribe:", error);
      toast.error(t("settings.history.retranscribeError"));
    } finally {
      setRetrying(false);
    }
  };

  const handleDelete = async () => {
    try {
      await onDelete(entry.id);
    } catch (error) {
      console.error("Failed to delete entry:", error);
      toast.error(t("settings.history.deleteError"));
    }
  };

  const closeMenu = () => {
    setMenuOpen(false);
    setConfirmDelete(false);
  };

  const date = new Date(Number(entry.timestamp) * 1000);
  const longDate = new Intl.DateTimeFormat(i18n.language, {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date);
  const time = new Intl.DateTimeFormat(i18n.language, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col rounded-xl border border-mid-gray/20 overflow-hidden">
      <div className="shrink-0 space-y-2 px-5 pt-4 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2
              className="text-xl font-semibold capitalize truncate"
              title={formatDateTime(String(entry.timestamp), i18n.language)}
            >
              {longDate}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-mid-gray">
              <span className="tabular-nums">{time}</span>
              {hasTranscription && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    {t("settings.history.wordCount", { count: words })}
                  </span>
                </>
              )}
              {entry.post_processed_text && (
                <span className="rounded-full border border-mid-gray/25 bg-mid-gray/5 px-2 py-0.5">
                  {t("settings.history.polished")}
                </span>
              )}
            </div>
          </div>

          <div className="relative flex items-center gap-1.5 shrink-0">
            <IconButton
              onClick={handleCopy}
              disabled={!hasTranscription || retrying}
              title={t("settings.history.copyToClipboard")}
            >
              {showCopied ? (
                <Check width={15} height={15} />
              ) : (
                <Copy width={15} height={15} />
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
                width={15}
                height={15}
                fill={entry.saved ? "currentColor" : "none"}
              />
            </IconButton>
            <MeetingButton historyId={entry.id} disabled={retrying} />
            <IconButton
              onClick={() => setMenuOpen((v) => !v)}
              title={t("settings.history.more")}
            >
              <MoreHorizontal width={15} height={15} />
            </IconButton>

            {menuOpen && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={closeMenu}
                  aria-hidden="true"
                />
                <div className="absolute right-0 top-full mt-1 z-20 min-w-52 rounded-lg border border-mid-gray/25 bg-background shadow-lg py-1">
                  <button
                    type="button"
                    onClick={() => {
                      closeMenu();
                      void handleRetranscribe();
                    }}
                    disabled={retrying}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-start hover:bg-mid-gray/15 cursor-pointer disabled:opacity-40"
                  >
                    <RotateCcw size={14} />
                    {t("settings.history.retranscribe")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      closeMenu();
                      onOpenFolder();
                    }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-start hover:bg-mid-gray/15 cursor-pointer"
                  >
                    <FolderOpen size={14} />
                    {t("settings.history.openFolder")}
                  </button>
                  <div className="my-1 border-t border-mid-gray/15" />
                  {confirmDelete ? (
                    <button
                      type="button"
                      onClick={() => {
                        closeMenu();
                        void handleDelete();
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-start font-medium text-red-400 bg-red-400/10 hover:bg-red-400/20 cursor-pointer"
                    >
                      <Trash2 size={14} />
                      {t("settings.history.deleteConfirm")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(true)}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-start text-red-400 hover:bg-mid-gray/15 cursor-pointer"
                    >
                      <Trash2 size={14} />
                      {t("settings.history.delete")}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto border-t border-mid-gray/20 px-5 py-4">
        {retrying && (
          <style>{`
            @keyframes transcribe-pulse {
              0%, 100% { color: color-mix(in srgb, var(--color-text) 40%, transparent); }
              50% { color: color-mix(in srgb, var(--color-text) 90%, transparent); }
            }
          `}</style>
        )}
        <p
          className={`text-sm leading-relaxed ${
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
          {retrying
            ? t("settings.history.transcribing")
            : hasTranscription
              ? text
              : t("settings.history.transcriptionFailed")}
        </p>
      </div>

      <div className="shrink-0 border-t border-mid-gray/20 px-5 py-3">
        <AudioPlayer
          key={entry.id}
          onLoadRequest={handleLoadAudio}
          className="w-full"
        />
      </div>
    </div>
  );
};
