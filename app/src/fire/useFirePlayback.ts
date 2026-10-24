import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const MIN_MODEL_MINUTES_PER_SECOND = 10;
/** At 1× a run longer than 3 h plays in about this many real seconds. */
const LONG_RUN_SECONDS = 18;

/**
 * Model minutes that pass per real second at 1×: 10 (a 3 h run plays in 18 s), rising with the
 * horizon so a 24 h run is 80 model minutes per second rather than minutes of waiting.
 */
export function modelMinutesPerSecond(horizonMinutes: number): number {
  return Math.max(MIN_MODEL_MINUTES_PER_SECOND, horizonMinutes / LONG_RUN_SECONDS);
}
/** Largest real-time step one animation frame may advance, so a background tab does not jump. */
const MAX_FRAME_DELTA_S = 0.1;
/** How often React overlay state follows the clock while playing (~10 Hz). */
const EMIT_INTERVAL_MS = 100;

export const PLAYBACK_SPEEDS = [0.5, 1, 2, 4] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export type FirePlayback = {
  /** Throttled copy of the clock for overlays (about 10 Hz while playing, exact on seek). */
  t: number;
  playing: boolean;
  speed: PlaybackSpeed;
  /** Exact current clock in model minutes, for imperative callers. */
  getTime: () => number;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  restart: () => void;
  seek: (minutes: number) => void;
  setSpeed: (speed: PlaybackSpeed) => void;
};

/**
 * Continuous model clock `t ∈ [0, duration]` in minutes since ignition. While playing, a
 * requestAnimationFrame loop advances it by real seconds × speed × the horizon rate and calls `onTime`
 * synchronously each frame, so the renderer is driven without a React render.
 */
export function useFirePlayback(
  duration: number,
  onTime: (minutes: number) => void,
): FirePlayback {
  const tRef = useRef(0);
  const speedRef = useRef<PlaybackSpeed>(1);
  const onTimeRef = useRef(onTime);
  useLayoutEffect(() => {
    onTimeRef.current = onTime;
  });

  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeedState] = useState<PlaybackSpeed>(1);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last: number | null = null;
    let lastEmit = 0;
    const frame = (now: number) => {
      const dt = last === null ? 0 : Math.min(MAX_FRAME_DELTA_S, (now - last) / 1000);
      last = now;
      const next = Math.min(
        duration,
        tRef.current + dt * speedRef.current * modelMinutesPerSecond(duration),
      );
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
      setT(tRef.current);
    };
  }, [playing, duration]);

  const seek = useCallback(
    (minutes: number) => {
      const next = Math.min(duration, Math.max(0, Number.isFinite(minutes) ? minutes : 0));
      tRef.current = next;
      onTimeRef.current(next);
      setT(next);
    },
    [duration],
  );

  // A shorter horizon must not leave the clock past the end.
  useEffect(() => {
    if (tRef.current > duration) seek(duration);
  }, [duration, seek]);

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

  return { t, playing, speed, getTime, play, pause, toggle, restart, seek, setSpeed };
}
