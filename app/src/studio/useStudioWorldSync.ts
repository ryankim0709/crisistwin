/**
 * Simulation Studio (/simulation, /dispatch) and the shared world (docs/shared-world.md): the
 * region and area size, the date and weather source, fuel moisture preset, the enabled fires,
 * natural variation and the random-scenario seed, both ways (world/useWorldSync.ts). Fields the
 * Studio cannot show (a custom area, a historical fire's board) are kept in the world untouched.
 */

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { boardCellMetersFor } from "../fire/boardSize";
import { CALIFORNIA_REGIONS } from "../fire/regions";
import { weatherSeriesFromRecord, type ScenarioWindRecord } from "../fire/scenarioWeather";
import type { FireSettings } from "../fire/scheduledTypes";
import { MOISTURE_PRESETS } from "../fire/spread";
import type { FireWeatherSeries } from "../fire/weatherSeries";
import { observedGustFactor } from "../fire/ui/NaturalVariationControl";
import type { World, WorldChanges, WorldWriter } from "../world/contracts";
import { useWorldSync, type WorldPath, type WorldSync } from "../world/useWorldSync";
import {
  assumedChoice,
  choiceOf,
  fetchWorldWind,
  recordMatchesWorld,
  worldChoice,
  type PinnedRecord,
  type WorldWeatherChoice,
} from "../world/weather";
import { MAX_WIND_SPEED_MPH, type ScheduledIgnition, type StudioScenario } from "./contracts";
import { createIgnition, parseScenario } from "./scenario";
import { findRegion, studioRadiusOverride } from "./useRegionBoard";

const MOISTURE_KEYS = ["dead1h", "dead10h", "dead100h", "liveHerb", "liveWoody"] as const;

/** The scenario with this weather record's hourly series and peak-hour wind (as ConfigPanel applies one). */
export function withWeatherRecord(scenario: StudioScenario, record: ScenarioWindRecord): StudioScenario {
  const settings: FireSettings = { ...scenario.settings };
  delete settings.weatherSeries;
  const converted = weatherSeriesFromRecord(record);
  const gust = observedGustFactor(record);
  return {
    ...scenario,
    weather: record,
    settings: {
      ...settings,
      ...(converted ? { weatherSeries: converted.series } : {}),
      ...(settings.stochastic ? { stochastic: { ...settings.stochastic, gustFactor: gust } } : {}),
      windSpeedMph: record.applied.speed20ftMph,
      windFromDegrees: record.applied.fromDeg,
    },
  };
}

function withAssumedWind(scenario: StudioScenario, speed: number, from: number): StudioScenario {
  const rest: StudioScenario = { ...scenario };
  delete rest.weather;
  const settings: FireSettings = { ...scenario.settings };
  delete settings.weatherSeries;
  return {
    ...rest,
    settings: {
      ...settings,
      windSpeedMph: Math.min(MAX_WIND_SPEED_MPH, Math.max(0, Math.round(speed))),
      windFromDegrees: ((Math.round(from) % 360) + 360) % 360,
    },
  };
}

/** What a random scenario picked, kept while its weather series is the scenario's. */
export interface SeriesChoice {
  series: FireWeatherSeries | undefined;
  choice: WorldWeatherChoice;
}

/** The page's settings a saved scenario restores beyond the shared world. */
interface StudioExtras {
  scenario: StudioScenario;
  regionId: string;
  boardRadius: number | null;
}

export interface StudioWorldSyncInput {
  tab: Extract<WorldWriter, "simulation" | "dispatch">;
  scenario: StudioScenario;
  applyScenario: (next: StudioScenario) => void;
  regionId: string;
  /** Studio board size (null: the region's own board). */
  boardRadius: number | null;
  /** Switch board; the page cancels and marks the run stale. */
  selectBoard: (regionId: string, radiusMeters: number | null) => void;
  showNotice: (message: string) => void;
}

export interface StudioWorldSync {
  sync: WorldSync;
  /** Record what a random scenario picked (its date, weather and seed) so it is written to the world. */
  noteRandom: (built: { series: FireWeatherSeries | undefined; choice: WorldWeatherChoice; seed: number }) => void;
  getExtras: () => StudioExtras;
  restoreExtras: (extras: unknown) => void;
}

export function useStudioWorldSync(input: StudioWorldSyncInput): StudioWorldSync {
  const { tab, scenario, regionId, boardRadius } = input;
  const latest = useRef(input);
  useLayoutEffect(() => {
    latest.current = input;
  });
  const [pinned, setPinned] = useState<PinnedRecord | null>(null);
  const [seriesChoice, setSeriesChoice] = useState<SeriesChoice | null>(null);
  const [startUtc, setStartUtc] = useState<string | undefined>(undefined);
  const [masterSeed, setMasterSeed] = useState<number | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  // ---- local state in world shape
  const region = findRegion(regionId);
  const { settings } = scenario;
  const seriesValid =
    seriesChoice !== null && !scenario.weather && seriesChoice.series === settings.weatherSeries;
  const weather: WorldWeatherChoice | undefined = scenario.weather
    ? choiceOf(scenario.weather, pinned)
    : seriesValid
      ? seriesChoice.choice
      : settings.weatherSeries
        ? undefined // a series of unknown origin (an imported draft): no opinion
        : assumedChoice(settings.windSpeedMph, settings.windFromDegrees);
  const preset = MOISTURE_PRESETS.find((p) =>
    MOISTURE_KEYS.every((key) => Math.abs(p.moisture[key] - settings.moisture[key]) < 1e-9),
  );
  const local: WorldChanges = {
    ...(region
      ? {
          region: {
            kind: "catalogue",
            id: region.id,
            name: region.name,
            center: [region.center.longitude, region.center.latitude],
            radiusMeters: boardRadius ?? region.radiusMeters,
            cellMeters: boardRadius === null ? region.cellMeters : boardCellMetersFor(boardRadius),
          },
        }
      : {}),
    conditions: {
      ...((weather?.startUtc ?? startUtc) ? { startUtc: weather?.startUtc ?? startUtc } : {}),
      ...(weather ? { weather: weather.weather } : {}),
      ...(seriesValid
        ? { moisture: { mode: "derived" } }
        : preset
          ? { moisture: { mode: "preset", preset: preset.id as "critical" | "dry" | "moderate" | "wet" } }
          : {}),
    },
    fire: {
      ignitions: scenario.ignitions
        .filter((ignition) => ignition.enabled)
        .map((ignition) => ({
          id: ignition.id,
          at: [ignition.location.longitude, ignition.location.latitude] as [number, number],
          startMinute: ignition.startMinute,
        })),
      stochastic: settings.stochastic
        ? { enabled: settings.stochastic.enabled, seed: Math.round(settings.stochastic.seed) >>> 0 }
        : { enabled: false },
    },
    ...(masterSeed !== undefined ? { seed: masterSeed } : {}),
  };

  // ---- remote → Studio
  const loadWeather = useCallback((world: World, at: [number, number]) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const hours = latest.current.scenario.settings.horizonMinutes / 60;
    fetchWorldWind(worldChoice(world), at[0], at[1], hours, controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted || !loaded) return;
        const { scenario: current, applyScenario } = latest.current;
        setPinned(loaded);
        applyScenario(withWeatherRecord(current, loaded.record));
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        latest.current.showNotice(
          `The shared world's weather could not be loaded: ${cause instanceof Error ? cause.message.split("; tried")[0] : "weather service error"}`,
        );
      });
  }, []);

  const apply = useCallback(
    (world: World, changed: ReadonlySet<WorldPath>) => {
      const { scenario: current, applyScenario, selectBoard, showNotice } = latest.current;
      let next = current;
      const r = world.region;
      if (changed.has("region")) {
        const target =
          r.kind === "catalogue" && r.id
            ? findRegion(r.id)
            : // A custom area, a drill or a historical fire: the catalogue board it sits on, if any.
              (CALIFORNIA_REGIONS.find((entry) => {
                const dx = (r.center[0] - entry.center.longitude) * 111_320 * Math.cos((entry.center.latitude * Math.PI) / 180);
                const dy = (r.center[1] - entry.center.latitude) * 110_540;
                return Math.hypot(dx, dy) < entry.radiusMeters * 0.8;
              }) ?? null);
        if (target) selectBoard(target.id, studioRadiusOverride(r.radiusMeters));
        else showNotice(`The shared world's area (${r.name}) has no Studio board; fires there load their own area.`);
      }
      if (changed.has("fire.ignitions")) {
        const byId = new Map(current.ignitions.map((ignition) => [ignition.id, ignition]));
        const ids = new Set(world.fire.ignitions.map((ignition) => ignition.id));
        let fires: ScheduledIgnition[] = [];
        for (const ignition of world.fire.ignitions) {
          const location = { longitude: ignition.at[0], latitude: ignition.at[1] };
          const known = byId.get(ignition.id);
          fires = [
            ...fires,
            known
              ? { ...known, location, startMinute: ignition.startMinute, enabled: true }
              : { ...createIgnition(fires, location, ignition.startMinute), id: ignition.id },
          ];
        }
        // Disabled fires are this tab's own drafts: kept, not in the world.
        const disabled = current.ignitions.filter((ignition) => !ignition.enabled && !ids.has(ignition.id));
        next = { ...next, ignitions: [...fires, ...disabled] };
      }
      const moisture = world.conditions.moisture;
      if (
        (changed.has("conditions.moisture.mode") || changed.has("conditions.moisture.preset")) &&
        moisture.mode === "preset" &&
        moisture.preset
      ) {
        const found = MOISTURE_PRESETS.find((p) => p.id === moisture.preset);
        if (found) next = { ...next, settings: { ...next.settings, moisture: { ...found.moisture } } };
      }
      if (changed.has("fire.stochastic.enabled") || changed.has("fire.stochastic.seed")) {
        const { enabled, seed } = world.fire.stochastic;
        const existing = next.settings.stochastic;
        next = {
          ...next,
          settings: {
            ...next.settings,
            stochastic: enabled || existing ? { ...(existing ?? {}), enabled, seed } : undefined,
          },
        };
        if (!next.settings.stochastic) delete next.settings.stochastic;
      }
      if (changed.has("conditions.startUtc")) setStartUtc(world.conditions.startUtc);
      const weatherChanged = [...changed].some(
        (p) => p.startsWith("conditions.weather.") || p === "conditions.startUtc",
      );
      if (weatherChanged) {
        const w = world.conditions.weather;
        if (w.mode === "assumed") {
          abortRef.current?.abort();
          next = withAssumedWind(next, w.windSpeedMph ?? next.settings.windSpeedMph, w.windFromDegrees ?? next.settings.windFromDegrees);
        } else if (!recordMatchesWorld(next.weather ?? null, world, pinned)) {
          const first = next.ignitions.filter((i) => i.enabled).sort((a, b) => a.startMinute - b.startMinute)[0];
          loadWeather(world, first ? [first.location.longitude, first.location.latitude] : r.center);
        }
      }
      // The master seed is recorded, not put in the Random seed box: that box stays "new each time".
      if (changed.has("seed")) setMasterSeed(world.seed);
      if (next !== current) applyScenario(next);
    },
    [loadWeather, pinned],
  );

  const sync = useWorldSync({ tab, local, apply });

  const noteRandom = useCallback(
    (built: { series: FireWeatherSeries | undefined; choice: WorldWeatherChoice; seed: number }) => {
      abortRef.current?.abort();
      setSeriesChoice({ series: built.series, choice: built.choice });
      setStartUtc(built.choice.startUtc);
      setMasterSeed(built.seed);
    },
    [],
  );

  const getExtras = useCallback(
    (): StudioExtras => ({
      scenario: latest.current.scenario,
      regionId: latest.current.regionId,
      boardRadius: latest.current.boardRadius,
    }),
    [],
  );

  const { hold } = sync;
  const restoreExtras = useCallback(
    (raw: unknown) => {
      const extras = raw as Partial<StudioExtras> | undefined;
      if (!extras || typeof extras !== "object") return;
      const parsed = parseScenario(extras.scenario);
      hold();
      if (parsed.scenario) latest.current.applyScenario(parsed.scenario);
      if (typeof extras.regionId === "string" && findRegion(extras.regionId)) {
        latest.current.selectBoard(extras.regionId, typeof extras.boardRadius === "number" ? extras.boardRadius : null);
      }
    },
    [hold],
  );

  return { sync, noteRandom, getExtras, restoreExtras };
}
