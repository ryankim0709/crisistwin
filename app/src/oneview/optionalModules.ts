/**
 * Modules other leads write in parallel (curated seeds, "What the agent sees", phone-followed
 * people), loaded only when they exist in the build: Vite's import.meta.glob matches a literal path
 * to zero or one file, so /run builds and typechecks before they land and picks them up after the
 * merge without edits. Each export documents its fallback. After the merge these can become plain
 * imports.
 */

import type { ComponentType } from "react";
import type { Board } from "../demo/model";
import type { DemoSeedPreset } from "../demo/runContracts";
import type { CommandBoard } from "../demo/useCommandBoard";

type Agent = CommandBoard["agent"];

/** FollowedPerson as fixed in ONEVIEW-BUILD-LOG.md (app/src/live/followedPeople.ts, lead H1). */
export interface FollowedPerson {
  personId: string;
  label: string;
  position: [number, number] | null;
  path: [number, number][];
  progress: number | null;
  status: string;
  followers: number;
  destination: { name: string; coord: [number, number] } | null;
}

const seedsModule = Object.values(
  import.meta.glob<{ DEMO_SEEDS?: DemoSeedPreset[] }>("./demoSeeds.ts", { eager: true }),
)[0];
const agentPanelModule = Object.values(
  import.meta.glob<{ default?: ComponentType<{ agent: Agent; board: Board | null }> }>("../demo/AgentInputsPanel.tsx", {
    eager: true,
  }),
)[0];
const followModule = Object.values(
  import.meta.glob<{ useFollowedPeople?: (token: string | null, incidentId: string) => unknown }>("../live/followedPeople.ts", {
    eager: true,
  }),
)[0];

/**
 * Stand-in preset, used only until lead I's curated seeds (oneview/demoSeeds.ts) are in the build.
 * ASSUMPTION (unsourced, demo stand-in): ignition point on the Grizzly Peak ridge above Berkeley,
 * a 25 mph wind from the northeast (the offshore "Diablo" direction) and critical fuel moisture.
 * Not measured: `measured` is null, so the page shows no outcome claim for it.
 */
const STAND_IN_SEED: DemoSeedPreset = {
  id: "berkeley-standin",
  label: "Berkeley Hills ridge fire (stand-in)",
  blurb: "Stand-in until the curated seeds land: a ridge-top start pushed downhill toward the hill homes by an offshore wind.",
  regionId: "berkeley-hills-tilden@15km",
  seed: 1,
  ignitions: [{ lon: -122.24, lat: 37.88, startMinute: 0, reportMinute: 10 }],
  wind: { speedMph: 25, fromDeg: 45 },
  moisturePreset: "critical",
  horizonMinutes: 240,
  measured: null,
};

/** Curated demo presets (lead I), else the one stand-in above. */
export const RUN_PRESETS: DemoSeedPreset[] =
  seedsModule?.DEMO_SEEDS && seedsModule.DEMO_SEEDS.length > 0 ? seedsModule.DEMO_SEEDS : [STAND_IN_SEED];
export const PRESETS_ARE_CURATED = RUN_PRESETS[0] !== STAND_IN_SEED;

/** "What the agent sees" (lead C's demo/AgentInputsPanel.tsx), or null (the page shows a fallback). */
export const AgentInputsPanel: ComponentType<{ agent: Agent; board: Board | null }> | null = agentPanelModule?.default ?? null;

function useNoFollowed(): FollowedPerson[] {
  return [];
}

/** Normalises the followed-people hook's answer (a list, or an object carrying `people`). */
function peopleOf(raw: unknown): FollowedPerson[] {
  if (Array.isArray(raw)) return raw as FollowedPerson[];
  if (raw && typeof raw === "object") {
    const r = raw as { people?: unknown; data?: { people?: unknown } | null };
    if (Array.isArray(r.people)) return r.people as FollowedPerson[];
    if (r.data && Array.isArray(r.data.people)) return r.data.people as FollowedPerson[];
  }
  return [];
}

const followHook = followModule?.useFollowedPeople;

/** Simulated people phones are following (lead H1's useFollowedPeople), or always [] before it lands. */
export const useFollowed: (token: string | null, incidentId: string) => FollowedPerson[] = followHook
  ? (token, incidentId) => peopleOf(followHook(token, incidentId))
  : useNoFollowed;
export const FOLLOW_AVAILABLE = !!followHook;
