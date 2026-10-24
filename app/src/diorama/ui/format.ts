import { useEffect, useState } from "react";
import type { Phase, PhaseId, Vec2 } from "../types";

/** Scenario seconds as `m:ss`. */
export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

const numberFormat = new Intl.NumberFormat("en-US");
export const formatCount = (value: number) => numberFormat.format(Math.max(0, Math.round(value)));

export function phaseAt(phases: readonly Phase[], id: PhaseId): Phase | undefined {
  return phases.find((phase) => phase.id === id);
}

const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];

/**
 * Bearing in degrees clockwise from map north for a world direction. World `x` grows east and
 * `z` grows south (see `types.ts`), so north is `-z`.
 */
export function bearingDeg(direction: Vec2): number {
  const deg = (Math.atan2(direction.x, -direction.z) * 180) / Math.PI;
  return (deg + 360) % 360;
}

export const compassName = (bearing: number) => COMPASS[Math.round(bearing / 45) % 8];

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && "matchMedia" in window ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (!("matchMedia" in window)) return;
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
