import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** Largest real-time step one animation frame may advance, so a background tab does not jump. */
const MAX_FRAME_DELTA_S = 0.1;
/** How often React overlay state follows the clock while playing (~10 Hz). */
const EMIT_INTERVAL_MS = 100;

export const PLAYBACK_SPEEDS = [0.5, 1, 2, 4] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export type PlaybackOptions = {
  /** Scenario length in scenario seconds. */
  duration: number;
  autoPlay?: boolean;
  /**
   * Called synchronously on every animation frame in which time changes and on every seek.
   * Drive imperative rendering (the three.js scene) from here, not from React state.
   */
  onTime: (t: number) => void;
};

export type Playback = {
  /** Throttled copy of the clock for React overlays (≈10 Hz while playing, exact on seek). */
  t: number;
  playing: boolean;
  speed: PlaybackSpeed;
  ended: boolean;
  /** Exact current clock, for imperative callers. */
  getTime: () => number;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  restart: () => void;
  seek: (t: number) => void;
  setSpeed: (speed: PlaybackSpeed) => void;
};

/**
 * Owns the scenario clock `t ∈ [0, duration]`. While playing, a requestAnimationFrame loop
 * advances `t` by real elapsed seconds × speed and stops at `duration`.
 */
export function usePlayback({ duration, autoPlay = true, onTime }: PlaybackOptions): Playback {
  const tRef = useRef(0);
  const speedRef = useRef<PlaybackSpeed>(1);
  const onTimeRef = useRef(onTime);
  useLayoutEffect(() => {
    onTimeRef.current = onTime;
  });

  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(autoPlay);
  const [speed, setSpeedState] = useState<PlaybackSpeed>(1);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last: number | null = null;
    let lastEmit = 0;
    const frame = (now: number) => {
      const dt = last === null ? 0 : Math.min(MAX_FRAME_DELTA_S, (now - last) / 1000);
      last = now;
      const next = Math.min(duration, tRef.current + dt * speedRef.current);
      if (next !== tRef.current) {
        tRef.current = next;
        onTimeRef.current(next);
      }
      if (next >= duration) {
        setT(next);
        setPlaying(false);
        return;
      }
      if (now - lastEmit >= EMIT_INTERVAL_MS) {
        lastEmit = now;
        setT(next);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      // Publish the exact paused time to the overlay.
      setT(tRef.current);
    };
  }, [playing, duration]);

  const seek = useCallback(
    (value: number) => {
      const next = Math.min(duration, Math.max(0, Number.isFinite(value) ? value : 0));
      tRef.current = next;
      onTimeRef.current(next);
      setT(next);
    },
    [duration],
  );

  const play = useCallback(() => {
    if (tRef.current >= duration) seek(0);
    setPlaying(true);
  }, [duration, seek]);

  const pause = useCallback(() => setPlaying(false), []);

  const toggle = useCallback(() => {
    if (tRef.current >= duration) {
      seek(0);
      setPlaying(true);
    } else {
      setPlaying((value) => !value);
    }
  }, [duration, seek]);

  const restart = useCallback(() => {
    seek(0);
    setPlaying(true);
  }, [seek]);

  const setSpeed = useCallback((value: PlaybackSpeed) => {
    speedRef.current = value;
    setSpeedState(value);
  }, []);

  const getTime = useCallback(() => tRef.current, []);

  return {
    t,
    playing,
    speed,
    ended: t >= duration,
    getTime,
    play,
    pause,
    toggle,
    restart,
    seek,
    setSpeed,
  };
}
