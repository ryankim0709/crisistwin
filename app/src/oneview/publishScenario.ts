/**
 * "Prepare" on /run: make a Berkeley Hills & Tilden drill package the live incident, then start the
 * preset's fire on the board with `POST /api/live/studio-fires` (studio/liveFire.ts payload, built
 * straight from the preset instead of a Studio run). Mirrors studio/usePublishLiveFire.ts
 * syncAndPublish: a stored package is reused when one fits; otherwise the preset is solved in this
 * page and stored as a new package first (oneview/studioPackage.ts), as Studio's "Use as live drill" does.
 *
 * Units as in studio/liveFire.ts: lon/lat WGS84 degrees, minutes from scenario T+0, wind mph FROM
 * degrees true, moisture fractions.
 */

import { activate, fetchPackages, type StoredPackage } from "../live/active";
import { MOISTURE_PRESETS } from "../fire/spread";
import { DISPATCH_BUILDER } from "../studio/drillPackage";
import { postLiveFire, type LiveFirePayload } from "../studio/liveFire";
import { fetchLiveDrill, liveToken, packageRegionId } from "../studio/liveSync";
import type { DemoSeedPreset } from "../demo/runContracts";
import { buildPresetPackage } from "./studioPackage";
import type { PrepareState, ScenarioDraft } from "./types";

export const BERKELEY_REGION = "berkeley-hills-tilden";

const regionOf = (boardId: string | null): string | null => (boardId ? boardId.split("@")[0] : null);

/**
 * A stored package's road box (`summary.bbox`, [west, south, east, north]) holds every ignition, and
 * its destinations are the current safe areas (built by DISPATCH_BUILDER, as studio/usePublishLiveFire.ts
 * requires); a package from an older area builder is rebuilt, not reused.
 */
function covers(pkg: StoredPackage, ignitions: ScenarioDraft["ignitions"]): boolean {
  if (pkg.summary.dispatch_builder !== DISPATCH_BUILDER) return false;
  const box = pkg.summary.bbox;
  if (!Array.isArray(box) || box.length !== 4 || !box.every((v) => typeof v === "number")) return false;
  const [west, south, east, north] = box as number[];
  return ignitions.every(({ lon, lat }) => lon >= west && lon <= east && lat >= south && lat <= north);
}

export function buildPresetPayload(draft: ScenarioDraft, preset: DemoSeedPreset, regionId: string): LiveFirePayload {
  const moisture = MOISTURE_PRESETS.find((m) => m.id === draft.moisturePreset) ?? MOISTURE_PRESETS[0];
  return {
    scenario_id: `run-${preset.id}`,
    name: preset.label.slice(0, 80),
    region_id: regionId,
    ignitions: draft.ignitions.map((ig, n) => {
      const start = Math.max(0, Math.round(ig.startMinute));
      return {
        id: `ign-${n + 1}`,
        name: `Ignition ${n + 1}`,
        lon: ig.lon,
        lat: ig.lat,
        start_minute: start,
        report_minute: ig.reportMinute === null || !Number.isFinite(ig.reportMinute) ? null : Math.max(Math.round(ig.reportMinute), start),
      };
    }),
    wind: {
      speed_mph: draft.windSpeedMph,
      from_deg: ((Math.round(draft.windFromDeg) % 360) + 360) % 360,
      source: "assumed",
      label: "Demo preset wind, set on the Scenario run page (assumed, not a weather record)",
    },
    moisture: {
      preset: moisture.id,
      label: moisture.label,
      values: { ...moisture.moisture },
    },
    horizon_minutes: Math.round(draft.horizonMinutes),
    weather_series: null,
  };
}

const messageOf = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);

export async function publishScenario(
  draft: ScenarioDraft,
  preset: DemoSeedPreset,
  signal: AbortSignal,
  update: (state: PrepareState) => void,
): Promise<void> {
  const say = (s: PrepareState) => {
    if (!signal.aborted) update(s);
  };
  say({ status: "checking" });
  let regionId: string;
  let switchedTo: string | null = null;
  try {
    const drill = await fetchLiveDrill(signal);
    const packages = await fetchPackages(liveToken(), signal);
    const activePkg = drill.active.package_id ? packages.find((p) => p.package_id === drill.active.package_id) ?? null : null;
    const activeOk =
      regionOf(drill.regionId) === BERKELEY_REGION && (activePkg === null || covers(activePkg, draft.ignitions));
    if (activeOk && drill.regionId) {
      regionId = drill.regionId;
    } else {
      const berkeley = packages.filter((p) => regionOf(packageRegionId(p)) === BERKELEY_REGION && covers(p, draft.ignitions));
      // Newest first (server order); prefer the preset's exact board size.
      const pick = berkeley.find((p) => packageRegionId(p) === preset.regionId) ?? berkeley[0] ?? null;
      if (pick) {
        say({ status: "switching", packageName: pick.summary.name });
        if (signal.aborted) return;
        await activate(liveToken(), { package_id: pick.package_id });
        regionId = packageRegionId(pick) ?? preset.regionId;
        switchedTo = pick.summary.name;
      } else {
        // No stored package fits: solve the preset here and store it as one (Studio's "Use as live drill").
        const built = await buildPresetPackage(draft, preset, signal, (step) => say({ status: "building", step }));
        if (signal.aborted) return;
        say({ status: "switching", packageName: built.summary.name });
        await activate(liveToken(), { package_id: built.package_id });
        regionId = preset.regionId;
        switchedTo = `${built.summary.name} (built just now)`;
      }
    }
  } catch (cause) {
    if (signal.aborted) return;
    say({ status: "failed", message: `Could not set up the live drill: ${messageOf(cause, "the live server did not answer.")}`, needsStudioPackage: false });
    return;
  }
  if (signal.aborted) return;
  say({ status: "sending" });
  try {
    const response = await postLiveFire(buildPresetPayload(draft, preset, regionId), signal);
    say({
      status: "done",
      fireId: response.fire_id,
      incidentId: response.incident_id,
      incidentName: response.incident_name,
      regionId,
      switchedTo,
      outsideDrill: response.outside_drill ?? [],
    });
  } catch (cause) {
    if (signal.aborted) return;
    say({ status: "failed", message: messageOf(cause, "Could not start the fire on the board."), needsStudioPackage: false });
  }
}
