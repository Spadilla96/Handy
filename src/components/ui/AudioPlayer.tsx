import React, {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Play, Pause } from "lucide-react";
import { useTranslation } from "react-i18next";

const SPEEDS = [1, 1.25, 1.5, 2] as const;
const SPEED_STORAGE_KEY = "audioPlayer.speed";

/** Speed label: "1×", "1.25×", "1.5×", "2×". */
const formatSpeed = (speed: number) => `${speed}×`;

/** Last speed the user picked, shared by every player; storage may be blocked. */
const readStoredSpeed = (): number => {
  try {
    const stored = Number(localStorage.getItem(SPEED_STORAGE_KEY));
    return (SPEEDS as readonly number[]).includes(stored) ? stored : 1;
  } catch {
    return 1;
  }
};

interface AudioPlayerProps {
  /** Audio source URL. If not provided, onLoadRequest must be provided. */
  src?: string;
  /** Called when play is clicked and no src is loaded yet. Should return the audio URL. */
  onLoadRequest?: () => Promise<string | null>;
  /** Called with the playhead position (seconds) as it moves. */
  onTimeUpdate?: (time: number) => void;
  className?: string;
  autoPlay?: boolean;
}

export interface AudioPlayerHandle {
  /** Jumps to `seconds` and plays, loading the audio first if needed. */
  seekTo: (seconds: number) => Promise<void>;
}

interface AudioPlayerGroupContextValue {
  requestPlayback: (audio: HTMLAudioElement) => void;
  releasePlayback: (audio: HTMLAudioElement) => void;
}

const AudioPlayerGroupContext =
  createContext<AudioPlayerGroupContextValue | null>(null);

export const AudioPlayerGroup: React.FC<React.PropsWithChildren> = ({
  children,
}) => {
  const activeAudioRef = useRef<HTMLAudioElement | null>(null);
  const value = useMemo<AudioPlayerGroupContextValue>(
    () => ({
      requestPlayback: (audio) => {
        if (activeAudioRef.current !== audio) activeAudioRef.current?.pause();
        activeAudioRef.current = audio;
      },
      releasePlayback: (audio) => {
        if (activeAudioRef.current === audio) activeAudioRef.current = null;
      },
    }),
    [],
  );

  return (
    <AudioPlayerGroupContext.Provider value={value}>
      {children}
    </AudioPlayerGroupContext.Provider>
  );
};

export const AudioPlayer = forwardRef<AudioPlayerHandle, AudioPlayerProps>(
  function AudioPlayer(
    {
      src: initialSrc,
      onLoadRequest,
      onTimeUpdate,
      className = "",
      autoPlay = false,
    },
    ref,
  ) {
    const { t } = useTranslation();
    const group = useContext(AudioPlayerGroupContext);
    const [speed, setSpeed] = useState(readStoredSpeed);
    const [isPlaying, setIsPlaying] = useState(false);
    const [duration, setDuration] = useState(0);
    const [currentTime, setCurrentTime] = useState(0);
    const [isDragging, setIsDragging] = useState(false);
    const [loadedSrc, setLoadedSrc] = useState<string | null>(
      initialSrc ?? null,
    );
    const [isLoading, setIsLoading] = useState(false);

    const audioRef = useRef<HTMLAudioElement>(null);
    const src = loadedSrc;
    const animationRef = useRef<number>();
    const dragTimeRef = useRef<number>(0);

    // Use refs to avoid stale closures in animation loop
    const isPlayingRef = useRef(false);
    const isDraggingRef = useRef(false);
    // Seek requested before the audio was loaded; applied on loadedmetadata.
    const pendingSeekRef = useRef<number | null>(null);
    const onTimeUpdateRef = useRef(onTimeUpdate);
    onTimeUpdateRef.current = onTimeUpdate;

    useEffect(() => {
      onTimeUpdateRef.current?.(currentTime);
    }, [currentTime]);

    // Keep refs in sync with state
    useEffect(() => {
      isPlayingRef.current = isPlaying;
    }, [isPlaying]);

    useEffect(() => {
      isDraggingRef.current = isDragging;
    }, [isDragging]);

    // Stable animation loop with no dependencies
    const tick = useCallback(() => {
      if (audioRef.current && !isDraggingRef.current) {
        const time = audioRef.current.currentTime;
        setCurrentTime(time);
      }

      if (isPlayingRef.current) {
        animationRef.current = requestAnimationFrame(tick);
      }
    }, []); // Empty dependency array is key!

    // Manage animation loop lifecycle
    useEffect(() => {
      if (isPlaying && !isDragging) {
        // Only start if not already running
        if (!animationRef.current) {
          animationRef.current = requestAnimationFrame(tick);
        }
      } else {
        // Stop animation loop
        if (animationRef.current) {
          cancelAnimationFrame(animationRef.current);
          animationRef.current = undefined;
        }
      }

      return () => {
        if (animationRef.current) {
          cancelAnimationFrame(animationRef.current);
          animationRef.current = undefined;
        }
      };
    }, [isPlaying, isDragging, tick]);

    // Apply the chosen speed (voice pitch preserved). The default rate is set
    // too because loading a new source resets playbackRate to it.
    useEffect(() => {
      const audio = audioRef.current;
      if (!audio) return;
      audio.defaultPlaybackRate = speed;
      audio.playbackRate = speed;
      audio.preservesPitch = true;
    }, [speed, src]);

    const chooseSpeed = (next: number) => {
      setSpeed(next);
      try {
        localStorage.setItem(SPEED_STORAGE_KEY, String(next));
      } catch {
        // Storage unavailable: the speed just won't be remembered.
      }
    };

    // Audio event handlers
    useEffect(() => {
      const audio = audioRef.current;
      if (!audio) return;

      const handleLoadedMetadata = () => {
        setDuration(audio.duration || 0);
        const pending = pendingSeekRef.current;
        pendingSeekRef.current = null;
        if (pending !== null) audio.currentTime = pending;
        setCurrentTime(pending ?? 0);
      };

      const handleEnded = () => {
        group?.releasePlayback(audio);
        setIsPlaying(false);
        setCurrentTime(audio.duration || 0);
      };

      const handlePlay = () => {
        group?.requestPlayback(audio);
        setIsPlaying(true);
      };
      const handlePause = () => {
        group?.releasePlayback(audio);
        setIsPlaying(false);
      };

      audio.addEventListener("loadedmetadata", handleLoadedMetadata);
      audio.addEventListener("ended", handleEnded);
      audio.addEventListener("play", handlePlay);
      audio.addEventListener("pause", handlePause);

      return () => {
        group?.releasePlayback(audio);
        audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
        audio.removeEventListener("ended", handleEnded);
        audio.removeEventListener("play", handlePlay);
        audio.removeEventListener("pause", handlePause);
      };
    }, [group]);

    // Auto-play when src becomes available (via onLoadRequest or autoPlay prop)
    const prevLoadedSrc = useRef<string | null>(null);
    useEffect(() => {
      const audio = audioRef.current;
      if (!audio) return;

      // Play when loadedSrc changes from null to a value (lazy load case)
      if (loadedSrc && !prevLoadedSrc.current && onLoadRequest) {
        audio.play().catch((error) => {
          console.error("Auto-play failed:", error);
        });
      }
      // Or when autoPlay is set with initial src
      else if (autoPlay && initialSrc && !prevLoadedSrc.current) {
        audio.play().catch((error) => {
          console.error("Auto-play failed:", error);
        });
      }

      prevLoadedSrc.current = loadedSrc;
    }, [loadedSrc, autoPlay, initialSrc, onLoadRequest]);

    // Global drag handlers
    const handleMouseUp = useCallback(() => {
      if (isDragging) {
        setIsDragging(false);
        if (audioRef.current) {
          audioRef.current.currentTime = dragTimeRef.current;
          setCurrentTime(dragTimeRef.current);
        }
      }
    }, [isDragging]);

    useEffect(() => {
      if (isDragging) {
        document.addEventListener("mouseup", handleMouseUp);
        document.addEventListener("touchend", handleMouseUp);

        return () => {
          document.removeEventListener("mouseup", handleMouseUp);
          document.removeEventListener("touchend", handleMouseUp);
        };
      }
    }, [isDragging, handleMouseUp]);

    // Cleanup blob URLs on unmount
    useEffect(() => {
      return () => {
        if (loadedSrc?.startsWith("blob:")) {
          URL.revokeObjectURL(loadedSrc);
        }
      };
    }, [loadedSrc]);

    const togglePlay = async () => {
      const audio = audioRef.current;
      if (!audio) return;
      if (isLoading) return;

      try {
        if (isPlaying) {
          audio.pause();
        } else {
          // If no src loaded yet, request it
          if (!src && onLoadRequest) {
            setIsLoading(true);
            const newSrc = await onLoadRequest();
            setIsLoading(false);
            if (newSrc) {
              setLoadedSrc(newSrc);
              // Playback will be triggered by the useEffect watching loadedSrc
            }
          } else if (src) {
            await audio.play();
          }
        }
      } catch (error) {
        console.error("Playback failed:", error);
      }
    };

    useImperativeHandle(ref, () => ({
      seekTo: async (seconds: number) => {
        const audio = audioRef.current;
        if (!audio || isLoading) return;
        if (!src) {
          if (!onLoadRequest) return;
          pendingSeekRef.current = seconds;
          setIsLoading(true);
          const newSrc = await onLoadRequest();
          setIsLoading(false);
          if (newSrc) setLoadedSrc(newSrc);
          else pendingSeekRef.current = null;
          // Playback starts from the loadedSrc effect; the seek on loadedmetadata.
          return;
        }
        audio.currentTime = seconds;
        setCurrentTime(seconds);
        try {
          await audio.play();
        } catch (error) {
          console.error("Playback failed:", error);
        }
      },
    }));

    const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newTime = parseFloat(e.target.value);
      dragTimeRef.current = newTime;
      setCurrentTime(newTime);

      if (!isDragging && audioRef.current) {
        audioRef.current.currentTime = newTime;
      }
    };

    const handleSliderMouseDown = () => {
      setIsDragging(true);
    };

    const handleSliderTouchStart = () => {
      setIsDragging(true);
    };

    const formatTime = (time: number): string => {
      if (!isFinite(time)) return "0:00";

      const minutes = Math.floor(time / 60);
      const seconds = Math.floor(time % 60);
      return `${minutes}:${seconds.toString().padStart(2, "0")}`;
    };

    // Fix playhead positioning with better edge case handling
    const getProgressPercent = (): number => {
      if (duration <= 0) return 0;

      // Handle the end case - if we're within 0.1 seconds of the end, show 100%
      if (duration - currentTime < 0.1) return 100;

      const percent = (currentTime / duration) * 100;
      return Math.min(100, Math.max(0, percent));
    };

    const progressPercent = getProgressPercent();

    return (
      <div className={`flex items-center gap-3 ${className}`}>
        <audio ref={audioRef} src={src ?? undefined} preload="metadata" />

        <button
          onClick={togglePlay}
          disabled={isLoading}
          className="transition-colors cursor-pointer text-text hover:text-logo-primary disabled:opacity-50"
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? (
            <Pause width={20} height={20} fill="currentColor" />
          ) : (
            <Play width={20} height={20} fill="currentColor" />
          )}
        </button>

        <div className="flex-1 flex items-center gap-2">
          <span className="text-xs text-text/60 min-w-[30px] tabular-nums">
            {formatTime(currentTime)}
          </span>

          <input
            type="range"
            min="0"
            max={duration || 0}
            step="0.01"
            value={currentTime}
            onChange={handleSeek}
            onMouseDown={handleSliderMouseDown}
            onTouchStart={handleSliderTouchStart}
            className={`flex-1 h-1 rounded-lg appearance-none cursor-pointer focus:outline-none focus:ring-1 focus:ring-logo-primary ${progressPercent >= 99.5 ? "[&::-webkit-slider-thumb]:translate-x-0.5 [&::-moz-range-thumb]:translate-x-0.5" : ""}`}
            style={{
              background: `linear-gradient(to right, var(--color-logo-primary) 0%, var(--color-logo-primary) ${progressPercent}%, rgba(128, 128, 128, 0.2) ${progressPercent}%, rgba(128, 128, 128, 0.2) 100%)`,
            }}
          />

          <span className="text-xs text-text/60 min-w-[30px] tabular-nums">
            {formatTime(duration)}
          </span>
        </div>

        <div
          role="group"
          aria-label={t("common.playbackSpeed")}
          className="shrink-0 inline-flex items-center rounded-full border border-mid-gray/25 bg-mid-gray/5 p-0.5"
        >
          {SPEEDS.map((option) => {
            const active = option === speed;
            return (
              <button
                key={option}
                type="button"
                onClick={() => chooseSpeed(option)}
                aria-pressed={active}
                title={`${t("common.playbackSpeed")}: ${formatSpeed(option)}`}
                className={`min-w-9 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums transition-colors cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-logo-primary ${
                  active
                    ? "bg-logo-primary text-white"
                    : "text-text/60 hover:text-text hover:bg-mid-gray/15"
                }`}
              >
                {formatSpeed(option)}
              </button>
            );
          })}
        </div>
      </div>
    );
  },
);
