import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Users } from "lucide-react";
import {
  initPendingMeetingSync,
  usePendingMeetingStore,
} from "@/stores/pendingMeetingStore";

const TITLE_DEBOUNCE_MS = 250;

/**
 * "This recording is a meeting" toggle shown while recording. Flagging it opens
 * a small popover to title the meeting; when the direct transcription is done,
 * Handy automatically processes it as a meeting (speaker separation).
 */
export const MarkMeetingButton: React.FC = () => {
  const { t } = useTranslation();
  const enabled = usePendingMeetingStore((s) => s.enabled);
  const name = usePendingMeetingStore((s) => s.name);
  const setPending = usePendingMeetingStore((s) => s.set);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    initPendingMeetingSync();
  }, []);

  // Keep the draft in sync when the backend/overlay changes the title.
  useEffect(() => {
    if (!open) setDraft(name);
  }, [name, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // The flag is consumed when the recording ends: close the popover with it.
  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);

  useEffect(() => () => window.clearTimeout(debounceRef.current), []);

  const onButtonClick = () => {
    if (!enabled) {
      void setPending(true, "");
      setDraft("");
      setOpen(true);
    } else {
      setOpen((v) => !v);
    }
  };

  const onDraftChange = (value: string) => {
    setDraft(value);
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(
      () => void setPending(true, value),
      TITLE_DEBOUNCE_MS,
    );
  };

  const commit = () => {
    window.clearTimeout(debounceRef.current);
    void setPending(true, draft.trim());
    setOpen(false);
  };

  const unmark = () => {
    window.clearTimeout(debounceRef.current);
    void setPending(false);
    setDraft("");
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onButtonClick}
        aria-pressed={enabled}
        aria-expanded={open}
        title={t("meetingMark.tooltip")}
        className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-full text-sm font-medium border cursor-pointer transition-colors ${
          enabled
            ? "bg-logo-primary/15 border-logo-primary/40 text-logo-primary"
            : "border-mid-gray/25 text-text/70 hover:bg-mid-gray/10 hover:text-text"
        }`}
      >
        {enabled ? <Check size={14} /> : <Users size={14} />}
        <span className="max-w-32 truncate">
          {enabled && name.trim() ? name.trim() : t("meetingMark.button")}
        </span>
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={commit}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-label={t("meetingMark.label")}
            className="absolute right-0 top-full mt-2 z-20 w-72 rounded-xl border border-mid-gray/25 bg-background shadow-lg p-3 space-y-2"
          >
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-mid-gray">
              <Users size={13} />
              {t("meetingMark.label")}
            </div>
            <input
              ref={inputRef}
              type="text"
              value={draft}
              maxLength={80}
              placeholder={t("meetingMark.placeholder")}
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") setOpen(false);
              }}
              className="w-full h-9 px-3 rounded-lg border border-mid-gray/30 bg-mid-gray/5 text-sm focus:outline-none focus:border-logo-primary"
            />
            <p className="text-xs text-mid-gray leading-snug">
              {t("meetingMark.hint")}
            </p>
            <div className="flex items-center justify-between pt-1">
              <button
                type="button"
                onClick={unmark}
                className="text-xs text-mid-gray hover:text-red-400 cursor-pointer"
              >
                {t("meetingMark.remove")}
              </button>
              <button
                type="button"
                onClick={commit}
                className="h-7 px-3 rounded-md text-xs font-semibold bg-logo-primary/15 text-logo-primary border border-logo-primary/40 hover:bg-logo-primary/25 cursor-pointer"
              >
                {t("meetingMark.done")}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
