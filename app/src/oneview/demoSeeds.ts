/**
 * Curated, low-variance demo scenarios for the single-view /run page: Berkeley Hills & Tilden at
 * 30 x 30 km. Method, every candidate tried and the numbers: docs/demo-seeds.md.
 *
 * Every scenario is a synthetic Studio fire (ASSUMPTION: the ignition points, the wind and the
 * "critical" fuel-moisture preset are illustrative scenario choices, not an observed or
 * forecast incident; the wind is the open 20 ft wind in mph, FROM degrees true). The board seed
 * fixes the board's random draws (response times, household behaviour), so a run with the same
 * seed repeats exactly (checked: a repeated seed gave identical results in all four scenarios).
 *
 * `measured` is what the headless evaluation harness (app/scripts/live-eval/evaluate.ts,
 * `--policy none`: nobody acts, no orders) reported for the preset's own seed at the end of its
 * horizon on the preset's own Studio drill package. People and homes are the board's synthetic
 * households (dispatch-area homes are synthetic), not counts of real residents. Measured on
 * feat/one-view 386b101 (SPREAD_MODEL 5.1.1, after the fire-resume fix: numbers taken before
 * that fix are superseded); re-measure after outcome-changing board or fire-solver changes.
 *
 * Order: the first preset is the most convincing and least variable one (the decision aids cut
 * both homes and people in every seed tested, and the no-action figures sit in a narrow band).
 */

import type { DemoSeedPreset } from "../demo/runContracts";

/** The Studio board id of the 30 x 30 km Berkeley Hills & Tilden board (15 km half-width). */
export const BERKELEY_BOARD_ID = "berkeley-hills-tilden@15km";

const HORIZON_MINUTES = 360;
/** Dispatch is told of the fire 4 board minutes after ignition (ASSUMPTION; harness `--report 4`). */
const REPORT_DELAY_MINUTES = 4;

export const DEMO_SEEDS: DemoSeedPreset[] = [
  {
    id: "berkeley-grizzly-peak-ene",
    label: "Grizzly Peak hills fire, strong ENE wind (slow build)",
    blurb:
      "A fire in the hills east of Grizzly Peak, driven toward the Berkeley neighbourhoods by a strong offshore wind. It builds slowly, then runs into the hill homes in the afternoon; the clearest case for early, staggered evacuation.",
    regionId: BERKELEY_BOARD_ID,
    seed: 1,
    ignitions: [{ lon: -122.218, lat: 37.876, startMinute: 0, reportMinute: REPORT_DELAY_MINUTES }],
    wind: { speedMph: 40, fromDeg: 60 },
    moisturePreset: "critical",
    horizonMinutes: HORIZON_MINUTES,
    measured: { homesBurned: 730, caughtPeople: 371, atMinute: HORIZON_MINUTES },
  },
  {
    id: "berkeley-claremont-hills-ene",
    label: "Claremont hills brush fire, strong ENE wind",
    blurb:
      "A brush fire in the hills east of Claremont Canyon, pushed downhill by a strong offshore wind. It reaches homes within half an hour: it shows what a fast first dispatch is worth.",
    regionId: BERKELEY_BOARD_ID,
    seed: 1,
    ignitions: [{ lon: -122.218, lat: 37.86, startMinute: 0, reportMinute: REPORT_DELAY_MINUTES }],
    wind: { speedMph: 40, fromDeg: 60 },
    moisturePreset: "critical",
    horizonMinutes: HORIZON_MINUTES,
    measured: { homesBurned: 1118, caughtPeople: 807, atMinute: HORIZON_MINUTES },
  },
  {
    id: "berkeley-two-spot-ene",
    label: "Two spot fires in the Berkeley hills, ENE wind",
    blurb:
      "Two fires start at once in the Berkeley hills and merge under an east-northeast wind: two fronts for the dispatcher to cover, and the hardest evacuation to stagger.",
    regionId: BERKELEY_BOARD_ID,
    seed: 1,
    ignitions: [
      { lon: -122.234, lat: 37.868, startMinute: 0, reportMinute: REPORT_DELAY_MINUTES },
      { lon: -122.226, lat: 37.876, startMinute: 0, reportMinute: REPORT_DELAY_MINUTES },
    ],
    wind: { speedMph: 35, fromDeg: 60 },
    moisturePreset: "critical",
    horizonMinutes: HORIZON_MINUTES,
    measured: { homesBurned: 1034, caughtPeople: 1115, atMinute: HORIZON_MINUTES },
  },
  {
    id: "berkeley-south-hills-east-wind",
    label: "South Berkeley hills fire, strong east wind",
    blurb:
      "A fire on the slope above the south Berkeley hill neighbourhoods in a strong, almost due-east wind: homes are close, and the evacuation roads downhill fill quickly.",
    regionId: BERKELEY_BOARD_ID,
    seed: 1,
    ignitions: [{ lon: -122.234, lat: 37.868, startMinute: 0, reportMinute: REPORT_DELAY_MINUTES }],
    wind: { speedMph: 40, fromDeg: 80 },
    moisturePreset: "critical",
    horizonMinutes: HORIZON_MINUTES,
    measured: { homesBurned: 1038, caughtPeople: 777, atMinute: HORIZON_MINUTES },
  },
];

/**
 * The measurements behind `measured` and the blurbs, per board seed 1, 2, 3 (docs/demo-seeds.md
 * has the method, the other candidates and the caveats). All values are from the evaluation
 * harness on each preset's own drill package; none are estimated.
 *
 * - noAction: `--policy none` (no orders, nobody dispatched).
 * - withDecisionAids: `--policy baseline`, the scripted policy (scripts/live-eval/baselinePolicy.ts)
 *   that uses only the model's own decision aids (crews, strategy, extra resources, evacuation
 *   orders), no LLM. It is the proxy for what an AI commander can do with the same information,
 *   not a measurement of the AI itself. `containedAtMinute` is the board minute the fire was
 *   contained, null if it was not (the run then went to the end of the horizon).
 */
export interface DemoSeedEvidence {
  seeds: number[];
  noAction: { homesBurned: number[]; caughtPeople: number[]; areaHa: number[] };
  withDecisionAids: { homesBurned: number[]; caughtPeople: number[]; areaHa: number[]; containedAtMinute: (number | null)[] };
  /** Board minute (10-minute steps) the first home had burned and the first household was caught, no action, per seed. */
  noActionFirstHomeMinute: number[];
  noActionFirstCaughtMinute: number[];
}

export const DEMO_SEED_EVIDENCE: Record<string, DemoSeedEvidence> = {
  "berkeley-grizzly-peak-ene": {
    seeds: [1, 2, 3],
    noAction: { homesBurned: [730, 802, 622], caughtPeople: [371, 388, 292], areaHa: [566.3, 557.6, 469.8] },
    withDecisionAids: { homesBurned: [465, 512, 190], caughtPeople: [129, 183, 102], areaHa: [465.1, 404.3, 240.1], containedAtMinute: [null, null, null] },
    noActionFirstHomeMinute: [150, 160, 160],
    noActionFirstCaughtMinute: [200, 190, 240],
  },
  "berkeley-claremont-hills-ene": {
    seeds: [1, 2, 3],
    noAction: { homesBurned: [1118, 1260, 1226], caughtPeople: [807, 1394, 903], areaHa: [674.6, 771.1, 747.4] },
    withDecisionAids: { homesBurned: [0, 1076, 1079], caughtPeople: [0, 247, 264], areaHa: [0.4, 657.4, 646.6], containedAtMinute: [18, null, null] },
    noActionFirstHomeMinute: [30, 20, 20],
    noActionFirstCaughtMinute: [100, 90, 90],
  },
  "berkeley-two-spot-ene": {
    seeds: [1, 2, 3],
    noAction: { homesBurned: [1034, 847, 1035], caughtPeople: [1115, 449, 1104], areaHa: [560.5, 568.1, 606.2] },
    withDecisionAids: { homesBurned: [951, 786, 807], caughtPeople: [496, 260, 236], areaHa: [439.9, 480.2, 443.9], containedAtMinute: [null, null, null] },
    noActionFirstHomeMinute: [70, 70, 60],
    noActionFirstCaughtMinute: [280, 260, 240],
  },
  "berkeley-south-hills-east-wind": {
    seeds: [1, 2, 3],
    noAction: { homesBurned: [1038, 1071, 1253], caughtPeople: [777, 861, 881], areaHa: [513, 515.5, 596.2] },
    withDecisionAids: { homesBurned: [935, 857, 1224], caughtPeople: [136, 399, 677], areaHa: [470.2, 430.2, 567.7], containedAtMinute: [null, null, null] },
    noActionFirstHomeMinute: [30, 30, 20],
    noActionFirstCaughtMinute: [120, 100, 90],
  },
};
