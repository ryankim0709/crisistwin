// A tab's shared-world controls: the scenario menu, a short sync status ("Synced", with "changed by
// Studio 2 s ago" in its tooltip) and the per-tab "Don't sync" switch (docs/shared-world.md).
import { useEffect, useState } from "react";
import { cx } from "../ui";
import type { Scenario, WorldWriter } from "./contracts";
import { ScenarioMenu } from "./ScenarioMenu";
import { useWorld } from "./useWorld";
import { WRITER_LABEL, type WorldSync } from "./useWorldSync";
import { RANDOM_NOTE_KEY, readRandomNote, type RandomNote } from "./randomScenario";
import "./world.css";

function ago(iso: string | null, now: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/** Short visible status, plus the longer detail for its tooltip. */
function syncStatus(sync: WorldSync, now: number, random: string | null): { text: string; detail: string } {
  if (!sync.enabled) return { text: "Not synced", detail: "Changes here stay in this tab" };
  if (!sync.loaded) {
    const text = sync.status === "error" ? "Shared world unavailable" : "Connecting…";
    return { text, detail: text };
  }
  if (sync.status === "saving") return { text: "Saving…", detail: "Saving to the shared world" };
  if (sync.error) return { text: sync.error, detail: sync.error };
  const { updatedBy, updatedAt, revision } = sync.world;
  const parts = ["Synced with other tabs"];
  if (random) parts.push(random);
  if (revision > 0 && updatedBy) parts.push(`changed by ${WRITER_LABEL[updatedBy]} ${ago(updatedAt, now)}`);
  return { text: "Synced", detail: parts.join(" · ") };
}

const utcDay = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });

/** Read-only: which shared world a page is on (for pages that only show it, e.g. /app-integration). */
export function WorldSummary({ className }: { className?: string }) {
  const { world, loaded, status } = useWorld();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(id);
  }, []);
  const day = Date.parse(world.conditions.startUtc);
  const text = !loaded
    ? status === "error"
      ? "Shared world unavailable"
      : "Loading the shared world…"
    : [
        world.region.name,
        Number.isFinite(day) ? `${utcDay.format(day)} UTC` : null,
      ]
        .filter(Boolean)
        .join(" · ");
  const detail = [
    world.liveIncidentId ? `Drill ${world.liveIncidentId}` : null,
    world.updatedBy ? `changed by ${WRITER_LABEL[world.updatedBy]} ${ago(world.updatedAt, now)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className={cx("wld-bar", className)}>
      <span className="wld-bar__status" title={detail || undefined}>
        {text}
      </span>
    </span>
  );
}

export interface WorldBarProps {
  tab: WorldWriter;
  sync: WorldSync;
  getExtras?: () => unknown;
  onLoaded?: (scenario: Scenario) => void;
  /** Where the scenario panel opens (see ScenarioMenu). */
  placement?: "down" | "up";
  align?: "end" | "start";
  className?: string;
}

export function WorldBar({ tab, sync, getExtras, onLoaded, placement, align, className }: WorldBarProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  // A random scenario another tab drew (world/randomScenario.ts), while the world still holds its seed.
  const [note, setNote] = useState<RandomNote | null>(() => readRandomNote());
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === RANDOM_NOTE_KEY) setNote(readRandomNote());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const random =
    note && note.by !== tab && sync.world.seed === note.seed
      ? `Random scenario from ${WRITER_LABEL[note.by]} · seed ${note.seed}`
      : null;
  const failing = sync.enabled && (sync.status === "error" || !!sync.error);
  const status = syncStatus(sync, now, random);
  return (
    <div className={cx("wld-bar", className)}>
      <ScenarioMenu
        tab={tab}
        getExtras={getExtras}
        onLoaded={onLoaded}
        placement={placement}
        align={align}
        syncEnabled={sync.enabled}
      />
      <span className="wld-bar__status" data-state={failing ? "error" : undefined} title={status.detail}>
        {status.text}
      </span>
      <label className="wld-bar__toggle" title="Keep changes in this tab only">
        <input type="checkbox" checked={!sync.enabled} onChange={(e) => sync.setEnabled(!e.target.checked)} />
        Don&rsquo;t sync
      </label>
    </div>
  );
}
