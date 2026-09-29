import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { commands } from "@/bindings";

type Mode = "ask" | "saved";

/** The offer disappears on its own if ignored. */
const AUTO_DISMISS_MS = 30_000;
const SAVED_DISMISS_MS = 8_000;

const initialMode = (): Mode =>
  new URLSearchParams(window.location.search).get("mode") === "saved"
    ? "saved"
    : "ask";

const MeetingPrompt: React.FC = () => {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unlisten = listen<Mode>("meeting-prompt-mode", (event) => {
      setMode(event.payload);
      setError(null);
      setBusy(false);
    });
    return () => {
      unlisten.then((un) => un());
    };
  }, []);

  useEffect(() => {
    const id = window.setTimeout(
      () => commands.dismissMeetingPrompt(),
      mode === "saved" ? SAVED_DISMISS_MS : AUTO_DISMISS_MS,
    );
    return () => window.clearTimeout(id);
  }, [mode]);

  const record = async () => {
    setBusy(true);
    const res = await commands.acceptMeetingPrompt();
    if (res.status === "error") {
      setBusy(false);
      setError(
        res.error === "models-missing"
          ? t("meetings.errors.modelsMissing")
          : res.error,
      );
    }
  };

  const ask = mode === "ask";
  return (
    <div className="h-full w-full bg-background text-text border border-mid-gray/30 rounded-lg p-4 flex flex-col justify-between select-none">
      <div>
        <p className="text-sm font-semibold">
          {ask ? t("meetings.prompt.askTitle") : t("meetings.prompt.savedTitle")}
        </p>
        <p className="text-xs text-mid-gray mt-1">
          {error ??
            (ask ? t("meetings.prompt.askBody") : t("meetings.prompt.savedBody"))}
        </p>
      </div>
      <div className="flex justify-end gap-2">
        {ask ? (
          <>
            <button
              type="button"
              className="px-3 py-1 text-xs rounded-md border border-mid-gray/30 hover:bg-mid-gray/10"
              onClick={() => commands.dismissMeetingPrompt()}
            >
              {t("meetings.prompt.notNow")}
            </button>
            <button
              type="button"
              disabled={busy}
              className="px-3 py-1 text-xs rounded-md text-white bg-red-600 hover:bg-red-700 disabled:opacity-50"
              onClick={record}
            >
              {t("meetings.prompt.record")}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="px-3 py-1 text-xs rounded-md border border-mid-gray/30 hover:bg-mid-gray/10"
            onClick={() => commands.dismissMeetingPrompt()}
          >
            {t("meetings.prompt.ok")}
          </button>
        )}
      </div>
    </div>
  );
};

export default MeetingPrompt;
