import type { TagTone } from "../ui";
import type { FireSource, FireStatus, TeamStatus } from "./model";

/** Simulation clock: "T+26:05" (hours:minutes since monitoring started). */
export function simClock(minute: number): string {
  const m = Math.max(0, Math.floor(minute));
  return `T+${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export const SOURCE_LABEL: Record<FireSource, string> = {
  scenario: "Ignition",
  spot: "Spot fire",
  field_report: "Field report",
  manual: "Added by hand",
};

export const FIRE_STATUS: Record<FireStatus, { label: string; tone: TagTone }> = {
  burning: { label: "Burning", tone: "danger" },
  contained: { label: "Contained", tone: "warning" },
  out: { label: "Out", tone: "success" },
};

export const TEAM_STATUS: Record<TeamStatus, string> = {
  available: "Available",
  en_route: "En route",
  on_scene: "On scene",
};

export const nf = (n: number) => Math.round(n).toLocaleString("en-US");
