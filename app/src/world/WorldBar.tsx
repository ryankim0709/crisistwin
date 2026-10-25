// A tab's shared-world controls: the scenario menu, a plain sync status ("Synced with other tabs ·
// changed by Studio 2 s ago") and the per-tab "Don't sync this tab" switch (docs/shared-world.md).
import { useEffect, useState } from "react";
import { cx } from "../ui";
import type { Scenario, WorldWriter } from "./contracts";
import { ScenarioMenu } from "./ScenarioMenu";
import { useWorld } from "./useWorld";
import { WRITER_LABEL, type WorldSync } from "./useWorldSync";
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

function syncStatusText(sync: WorldSync, now: number): string {
  if (!sync.enabled) return "Not synced: changes here stay in this tab";
  if (!sync.loaded) return sync.status === "error" ? "Shared world unavailable" : "Connecting to the shared world…";
  if (sync.status === "saving") return "Synced with other tabs · saving…";
  if (sync.error) return sync.error;
  const { updatedBy, updatedAt, revision } = sync.world;
  if (revision === 0 || !updatedBy) return "Synced with other tabs";
  return `Synced with other tabs · changed by ${WRITER_LABEL[updatedBy]} ${ago(updatedAt, now)}`;
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
        `World: ${world.region.name}`,
        Number.isFinite(day) ? `${utcDay.format(day)} UTC` : null,
        world.liveIncidentId ? `drill ${world.liveIncidentId}` : null,
        world.updatedBy ? `changed by ${WRITER_LABEL[world.updatedBy]} ${ago(world.updatedAt, now)}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
  return (
    <span className={cx("wld-bar", className)}>
      <span className="wld-bar__status">{text}</span>
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
  const failing = sync.enabled && (sync.status === "error" || !!sync.error);
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
      <span className="wld-bar__status" data-state={failing ? "error" : undefined}>
        {syncStatusText(sync, now)}
      </span>
      <label className="wld-bar__toggle">
        <input type="checkbox" checked={!sync.enabled} onChange={(e) => sync.setEnabled(!e.target.checked)} />
        Don&rsquo;t sync this tab
      </label>
    </div>
  );
}
