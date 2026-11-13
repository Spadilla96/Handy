import React, { useCallback, useEffect, useState } from "react";
import {
  Check,
  Copy,
  FolderOpen,
  MoreHorizontal,
  RotateCcw,
  SlidersHorizontal,
  Star,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { commands, type HistoryEntry, type ModelInfo } from "@/bindings";
import { formatDateTime } from "@/utils/dateFormat";
import { AudioPlayer } from "../../ui/AudioPlayer";
import { IconButton, MeetingButton } from "./HistoryActions";

/** Per-run choices for a re-transcription; empty = the app's defaults. */
export interface RetranscribeOptions {
  /** Model id to use for this run only (default: the selected model). */
  model?: string;
  /** Apply high-pass + volume normalization before transcribing. */
  enhance?: boolean;
}

interface HistoryDetailProps {
  entry: HistoryEntry;
  onToggleSaved: () => void;
  onCopyText: () => Promise<boolean>;
  getAudioUrl: (fileName: string) => Promise<string | null>;
  onDelete: (id: number) => Promise<void>;
  onRetranscribe: (id: number, options?: RetranscribeOptions) => Promise<void>;
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
  const [showOptions, setShowOptions] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [optModel, setOptModel] = useState("");
  const [optEnhance, setOptEnhance] = useState(false);

  // A different entry starts with a clean slate.
  useEffect(() => {
    setMenuOpen(false);
    setConfirmDelete(false);
    setShowOptions(false);
    setShowCopied(false);
  }, [entry.id]);

  // Installed models, to pick one for a single re-transcription.
  useEffect(() => {
    if (!showOptions) return;
    void commands.getAvailableModels().then((res) => {
      if (res.status === "ok") {
        setModels(res.data.filter((m) => m.is_downloaded));
      }
    });
  }, [showOptions]);

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

  const handleRetranscribe = async (options?: RetranscribeOptions) => {
    try {
      setRetrying(true);
      await onRetranscribe(entry.id, options);
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
    setShowOptions(false);
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
                <div
                  className={`absolute right-0 top-full mt-1 z-20 rounded-lg border border-mid-gray/25 bg-background shadow-lg py-1 ${
                    showOptions ? "w-72" : "min-w-52"
                  }`}
                >
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
                    onClick={() => setShowOptions((v) => !v)}
                    disabled={retrying}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-start hover:bg-mid-gray/15 cursor-pointer disabled:opacity-40"
                  >
                    <SlidersHorizontal size={14} />
                    {t("settings.history.retranscribeWithOptions")}
                  </button>
                  {showOptions && (
                    <div className="mx-2 my-1 space-y-2 rounded-md border border-mid-gray/20 bg-mid-gray/5 p-2.5">
                      <label className="block space-y-1">
                        <span className="text-xs text-mid-gray">
                          {t("settings.history.retranscribeModel")}
                        </span>
                        <select
                          value={optModel}
                          onChange={(e) => setOptModel(e.target.value)}
                          className="w-full rounded-md border border-mid-gray/25 bg-background px-2 py-1 text-sm"
                        >
                          <option value="">
                            {t("settings.history.retranscribeModelCurrent")}
                          </option>
                          {models.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label
                        className="flex items-start gap-2 text-sm cursor-pointer"
                        title={t("settings.history.retranscribeEnhanceHint")}
                      >
                        <input
                          type="checkbox"
                          checked={optEnhance}
                          onChange={(e) => setOptEnhance(e.target.checked)}
                          className="mt-0.5"
                        />
                        <span>{t("settings.history.retranscribeEnhance")}</span>
                      </label>
                      <button
                        type="button"
                        onClick={() => {
                          closeMenu();
                          void handleRetranscribe({
                            model: optModel || undefined,
                            enhance: optEnhance,
                          });
                        }}
                        disabled={retrying}
                        className="w-full rounded-md bg-logo-primary px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 cursor-pointer disabled:opacity-40"
                      >
                        {t("settings.history.retranscribeRun")}
                      </button>
                    </div>
                  )}
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
