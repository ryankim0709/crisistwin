import type { TagTone } from "../ui";
import type { FireSource, FireStatus, TeamStatus } from "./model";

/** Simulation clock: "T+26:05" (hours:minutes since monitoring started). */
export function simClock(minute: number): string {
  const m = Math.max(0, Math.floor(minute));
  return `T+${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export const SOURCE_LABEL: Record<FireSource, string> = {
  studio: "Simulation Studio",
};

export const FIRE_STATUS: Record<FireStatus, { label: string; tone: TagTone }> = {
  burning: { label: "Burning", tone: "danger" },
  contained: { label: "✓ Contained", tone: "success" },
  out: { label: "✓ Out", tone: "success" },
};

export const TEAM_STATUS: Record<TeamStatus, string> = {
  available: "Available",
  en_route: "En route",
  on_scene: "On scene",
  returning: "Returning to station",
  refilling: "Refilling water",
  moving_up: "Moving up to cover",
  resting: "Resting (work/rest)",
  out_of_service: "Out of service",
};

export const nf = (n: number) => Math.round(n).toLocaleString("en-US");

/** Minutes for people: whole minutes ("5 min"), "<1 min" under one, never a raw float. */
export function minutesText(n: number): string {
  if (n > 0 && n < 1) return "<1 min";
  return `${nf(n)} min`;
}

/** Whole minutes inside prose: "0.8669 min after" -> "<1 min after", "2.4 min" -> "2 min"; any other long decimal is shortened to one place. */
export function tidyMinutes(text: string): string {
  return text
    .replace(/(\d+\.\d+)(\s*)min\b/g, (_m, n: string, space: string) => `${minutesText(Number(n)).replace(/ min$/, "")}${space}min`)
    .replace(/\d+\.\d{3,}/g, (n) => String(Math.round(Number(n) * 10) / 10));
}

const STATION_WORDS = /\b(fire|department|dept\.?|station|stn\.?|number|no\.?|engine|company|house|headquarters|hq)\b|#/gi;

/**
 * Short map label for a fire station's OpenStreetMap name, so labels do not pile up:
 * "Berkeley Fire Station Number 5" -> "BFD 5", "Oakland Fire Station #8" -> "OFD 8",
 * "Fire Station Number 2" -> "Stn 2", "Berkeley Fire Department Station" -> "BFD". The full name
 * stays in tooltips and the side panels.
 */
export function shortStationName(name: string): string {
  const calFire = name.match(/^\s*cal\s*fire\b/i);
  if (calFire) {
    const n = name.match(/(\d+)(?!.*\d)/)?.[1];
    return n ? `CAL FIRE ${n}` : "CAL FIRE";
  }
  const fireAt = name.search(/\bfire\b/i);
  const place = (fireAt > 0 ? name.slice(0, fireAt) : "").replace(STATION_WORDS, " ").trim();
  const number = name.match(/(\d+)(?!.*\d)/)?.[1] ?? null;
  const dept = place
    ? `${place
        .split(/\s+/)
        .map((word) => word[0]?.toUpperCase() ?? "")
        .join("")}FD`
    : null;
  if (dept) return number ? `${dept} ${number}` : dept;
  if (number) return `Stn ${number}`;
  const rest = name.replace(STATION_WORDS, " ").replace(/\s+/g, " ").trim();
  return rest ? (rest.length > 16 ? `${rest.slice(0, 15)}…` : rest) : "Station";
}
