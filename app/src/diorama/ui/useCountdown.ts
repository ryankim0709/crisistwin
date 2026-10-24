import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Countdown in whole seconds while `active`, calling `onDone` once when it reaches zero.
 * Returns null when inactive.
 */
export function useCountdown(active: boolean, seconds: number, onDone: () => void): number | null {
  const [remaining, setRemaining] = useState(seconds);
  const doneCb = useRef(onDone);
  useLayoutEffect(() => {
    doneCb.current = onDone;
  });

  useEffect(() => {
    if (!active) return;
    const started = performance.now();
    const id = window.setInterval(() => {
      const left = Math.max(0, seconds - Math.floor((performance.now() - started) / 1000));
      setRemaining(left);
      if (left === 0) {
        window.clearInterval(id);
        doneCb.current();
      }
    }, 250);
    return () => {
      window.clearInterval(id);
      setRemaining(seconds);
    };
  }, [active, seconds]);

  return active ? remaining : null;
}
