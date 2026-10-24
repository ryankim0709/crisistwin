/**
 * Device-local draft storage and JSON export. Storage can be unavailable or throw (private
 * windows, blocked site data), so every access is guarded and failure is reported, not hidden.
 */

import type { StudioScenario } from "./contracts";
import { parseScenario } from "./scenario";

export const DRAFT_STORAGE_KEY = "crisistwin.simulationStudio.draft.v1";

interface StoredDraft {
  savedAtIso: string;
  scenario: unknown;
}

export interface LoadedDraft {
  scenario: StudioScenario;
  savedAt: Date;
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
    return { scenario, savedAt: Number.isNaN(savedAt.getTime()) ? new Date(0) : savedAt };
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
    const stored: StoredDraft = { savedAtIso: savedAt.toISOString(), scenario };
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
