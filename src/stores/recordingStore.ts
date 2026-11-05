import { create } from "zustand";
import { commands } from "@/bindings";

interface RecordingStore {
  isRecording: boolean;
  /** Epoch ms when the current recording was first seen, or null. */
  startedAt: number | null;
  refresh: () => Promise<void>;
}

/**
 * Mirrors the backend recording state for the main window. The backend only
 * emits recording events to the overlay window, so the main window polls
 * `is_recording` (cheap, in-memory) while it is visible.
 */
export const useRecordingStore = create<RecordingStore>()((set, get) => ({
  isRecording: false,
  startedAt: null,

  refresh: async () => {
    let recording = false;
    try {
      recording = await commands.isRecording();
    } catch {
      return;
    }
    if (recording === get().isRecording) return;
    set({ isRecording: recording, startedAt: recording ? Date.now() : null });
  },
}));
