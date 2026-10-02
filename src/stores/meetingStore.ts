import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import {
  commands,
  type DiarizationJob,
  type DiarizeFailedEvent,
  type MeetingModelsStatus,
  type MeetingSavedEvent,
  type MeetingSummary,
} from "@/bindings";
import i18n from "@/i18n";

interface MeetingStore {
  initialized: boolean;
  models: MeetingModelsStatus | null;
  job: DiarizationJob | null;
  meetings: MeetingSummary[];
  /** History entry id -> id of the meeting created from it. */
  meetingByHistory: Record<number, number>;
  /** Meeting the Meetings page should open next (set from elsewhere). */
  openRequest: number | null;
  /** Bumped to ask the app to switch to the Meetings page. */
  navigateNonce: number;

  initialize: () => Promise<void>;
  refreshMeetings: () => Promise<void>;
  refreshModels: () => Promise<void>;
  downloadModels: () => Promise<boolean>;
  diarize: (historyId: number) => Promise<void>;
  cancel: () => Promise<void>;
  showMeeting: (meetingId: number) => void;
  consumeOpenRequest: () => number | null;
}

const indexByHistory = (meetings: MeetingSummary[]) => {
  const map: Record<number, number> = {};
  // Newest first, so the latest meeting for an entry wins.
  for (const m of [...meetings].reverse()) {
    if (m.source_history_id != null) map[m.source_history_id] = m.id;
  }
  return map;
};

export const useMeetingStore = create<MeetingStore>()((set, get) => ({
  initialized: false,
  models: null,
  job: null,
  meetings: [],
  meetingByHistory: {},
  openRequest: null,
  navigateNonce: 0,

  initialize: async () => {
    if (get().initialized) return;
    set({ initialized: true });

    listen<MeetingModelsStatus>("meeting-models-progress", (event) =>
      set({ models: event.payload }),
    );
    listen<DiarizationJob>("meeting-diarize-progress", (event) =>
      set({ job: event.payload }),
    );
    listen<MeetingSavedEvent>("meeting-saved", async (event) => {
      set({ job: null });
      await get().refreshMeetings();
      const { meeting_id } = event.payload;
      toast.success(i18n.t("meetings.diarize.done"), {
        action: {
          label: i18n.t("meetings.diarize.view"),
          onClick: () => get().showMeeting(meeting_id),
        },
      });
    });
    listen<DiarizeFailedEvent>("meeting-diarize-failed", (event) => {
      set({ job: null });
      if (!event.payload.cancelled) {
        toast.error(
          i18n.t("meetings.diarize.failed", { error: event.payload.message }),
        );
      }
    });

    const [job] = await Promise.all([
      commands.getDiarizationJob(),
      get().refreshMeetings(),
      get().refreshModels(),
    ]);
    set({ job });
  },

  refreshMeetings: async () => {
    const res = await commands.listMeetings();
    if (res.status === "ok") {
      set({ meetings: res.data, meetingByHistory: indexByHistory(res.data) });
    }
  },

  refreshModels: async () => {
    set({ models: await commands.getMeetingModelsStatus() });
  },

  downloadModels: async () => {
    const res = await commands.downloadMeetingModels();
    await get().refreshModels();
    if (res.status === "error") {
      toast.error(res.error);
      return false;
    }
    return true;
  },

  diarize: async (historyId) => {
    // Shown right away; the backend's progress events take over from here.
    set({ job: { history_id: historyId, progress: 0, backend: null } });
    const res = await commands.diarizeHistoryEntry(historyId);
    if (res.status === "error") {
      set({ job: null });
      toast.error(
        res.error === "models-missing"
          ? i18n.t("meetings.errors.modelsMissing")
          : i18n.t("meetings.diarize.failed", { error: res.error }),
      );
    }
  },

  cancel: async () => {
    await commands.cancelMeetingDiarization();
  },

  showMeeting: (meetingId) =>
    set((state) => ({
      openRequest: meetingId,
      navigateNonce: state.navigateNonce + 1,
    })),

  consumeOpenRequest: () => {
    const id = get().openRequest;
    if (id !== null) set({ openRequest: null });
    return id;
  },
}));
