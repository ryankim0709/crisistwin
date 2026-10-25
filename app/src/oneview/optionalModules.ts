/**
 * Curated demo seeds (lead I's oneview/demoSeeds.ts), loaded only when the file is in the build:
 * Vite's import.meta.glob matches a literal path to zero or one file, so /run builds and typechecks
 * before it lands and picks it up after the merge without edits. Once it is merged this can become
 * a plain import.
 */

import type { DemoSeedPreset } from "../demo/runContracts";

const seedsModule = Object.values(
  import.meta.glob<{ DEMO_SEEDS?: DemoSeedPreset[] }>("./demoSeeds.ts", { eager: true }),
)[0];

/**
 * Stand-in preset, used only until lead I's curated seeds (oneview/demoSeeds.ts) are in the build.
 * ASSUMPTION (unsourced, demo stand-in): ignition point in Claremont Canyon above the Claremont
 * hill homes, a 25 mph wind from the northeast (the offshore "Diablo" direction) and critical fuel
 * moisture. The point was picked by a scratch scan of the board's own fire solve (no action, seed 1):
 * the earlier point (-122.24, 37.88) sits in developed ground and timber litter with the wind
 * running downslope, so it burned about 1 ha in the first hour and reached no homes in 2 h; this
 * one reaches homes within the first hour. Not measured: `measured` is null, so the page shows no
 * outcome claim for it.
 */
const STAND_IN_SEED: DemoSeedPreset = {
  id: "berkeley-standin",
  label: "Berkeley Hills ridge fire (stand-in)",
  blurb: "Stand-in until the curated seeds land: a Claremont Canyon start pushed downhill toward the hill homes by an offshore wind.",
  regionId: "berkeley-hills-tilden@15km",
  seed: 1,
  ignitions: [{ lon: -122.235, lat: 37.86, startMinute: 0, reportMinute: 10 }],
  wind: { speedMph: 25, fromDeg: 45 },
  moisturePreset: "critical",
  horizonMinutes: 240,
  measured: null,
};

/** Curated demo presets (lead I), else the one stand-in above. */
export const RUN_PRESETS: DemoSeedPreset[] =
  seedsModule?.DEMO_SEEDS && seedsModule.DEMO_SEEDS.length > 0 ? seedsModule.DEMO_SEEDS : [STAND_IN_SEED];
export const PRESETS_ARE_CURATED = RUN_PRESETS[0] !== STAND_IN_SEED;
