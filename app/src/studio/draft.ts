/**
 * Device-local draft storage and JSON export. Storage can be unavailable or throw (private
 * windows, blocked site data), so every access is guarded and failure is reported, not hidden.
 */

import type { StudioScenario } from "./contracts";
import { parseScenario } from "./scenario";

export const DRAFT_STORAGE_KEY = "crisistwin.simulationStudio.draft.v1";
/**
 * Version of the Studio's defaults a draft was saved under. 2: firefighting (the first-alarm
 * package from real stations) is on by default. 3: units come from the facilities on the map;
 * a draft's hand-set unit counts are dropped on load (parseScenario sets `countsDropped`). A
 * draft saved before version 2 gets firefighting turned on once by the page; after that the
 * user's own choice is kept.
 */
export const DRAFT_DEFAULTS_VERSION = 4;
/** Version 4: default run length went from 3 h to 24 h; older drafts still on 3 h move up once. */
export const HORIZON_24H_DEFAULTS_VERSION = 4;
/** Drafts saved before this version get firefighting turned on once (the page's migration). */
export const FIREFIGHTING_ON_DEFAULTS_VERSION = 2;

interface StoredDraft {
  savedAtIso: string;
  scenario: unknown;
  defaults?: number;
}

export interface LoadedDraft {
  scenario: StudioScenario;
  savedAt: Date;
  /** DRAFT_DEFAULTS_VERSION it was saved under (1 for drafts saved before versions existed). */
  defaultsVersion: number;
}

/** The saved draft, or null when none exists, storage is unavailable or the data is invalid. */
export function loadDraft(key: string = DRAFT_STORAGE_KEY): LoadedDraft | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const stored = JSON.parse(raw) as Partial<StoredDraft> | null;
    if (!stored || typeof stored !== "object") return null;
    const { scenario } = parseScenario(stored.scenario);
    if (!scenario) return null;
    const savedAt = new Date(typeof stored.savedAtIso === "string" ? stored.savedAtIso : NaN);
    return {
      scenario,
      savedAt: Number.isNaN(savedAt.getTime()) ? new Date(0) : savedAt,
      defaultsVersion: typeof stored.defaults === "number" ? stored.defaults : 1,
    };
  } catch {
    return null;
  }
}

/** Saves the draft. Returns the save time, or null when storage refused it. */
export function saveDraft(
  scenario: StudioScenario,
  key: string = DRAFT_STORAGE_KEY,
): Date | null {
  try {
    const savedAt = new Date();
    const stored: StoredDraft = {
      savedAtIso: savedAt.toISOString(),
      scenario,
      defaults: DRAFT_DEFAULTS_VERSION,
    };
    window.localStorage.setItem(key, JSON.stringify(stored));
    return savedAt;
  } catch {
    return null;
  }
}

export function clearDraft(key: string = DRAFT_STORAGE_KEY): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

export function draftStatusText(savedAt: Date | null, failed: boolean): string | null {
  if (failed) return "Could not save on this device";
  if (!savedAt || savedAt.getTime() === 0) return savedAt ? "Saved on this device" : null;
  return `Saved on this device · ${savedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

export function exportScenarioJson(scenario: StudioScenario): string {
  return JSON.stringify(scenario, null, 2);
}
