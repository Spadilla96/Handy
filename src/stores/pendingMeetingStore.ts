import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { commands } from "@/bindings";
import type { PendingMeeting } from "@/bindings";

interface PendingMeetingStore extends PendingMeeting {
  /** Flag (or unflag) the recording in progress as a meeting. */
  set: (enabled: boolean, name?: string) => Promise<void>;
  /** Pull the backend state (used on mount). */
  refresh: () => Promise<void>;
}

/**
 * Mirrors the backend's "this recording is a meeting" flag. The backend is the
 * source of truth (it is consumed when the recording ends), and broadcasts
 * `pending-meeting-changed` so the main window and the overlay stay in sync.
 */
export const usePendingMeetingStore = create<PendingMeetingStore>()((set) => ({
  enabled: false,
  name: "",

  set: async (enabled, name = "") => {
    // Optimistic: keeps the input responsive while typing.
    set({ enabled, name: enabled ? name : "" });
    try {
      await commands.setPendingMeeting(enabled, name);
    } catch (error) {
      console.error("Failed to set pending meeting:", error);
    }
  },

  refresh: async () => {
    try {
      const value = await commands.getPendingMeeting();
      set({ enabled: value.enabled, name: value.name });
    } catch (error) {
      console.error("Failed to read pending meeting:", error);
    }
  },
}));

let subscribed = false;

/** Subscribe once per window to backend changes. */
export const initPendingMeetingSync = () => {
  if (subscribed) return;
  subscribed = true;
  void usePendingMeetingStore.getState().refresh();
  void listen<PendingMeeting>("pending-meeting-changed", (event) => {
    usePendingMeetingStore.setState({
      enabled: event.payload.enabled,
      name: event.payload.name,
    });
  });
};
