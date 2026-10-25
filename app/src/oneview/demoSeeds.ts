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
 * feat/one-view e67007d (board self-evacuation on, fleets and safe areas as of that commit);
 * re-measure after outcome-changing board changes.
 */

import type { DemoSeedPreset } from "../demo/runContracts";

/** The Studio board id of the 30 x 30 km Berkeley Hills & Tilden board (15 km half-width). */
export const BERKELEY_BOARD_ID = "berkeley-hills-tilden@15km";

const HORIZON_MINUTES = 360;
/** Dispatch is told of the fire 4 board minutes after ignition (ASSUMPTION; harness `--report 4`). */
const REPORT_DELAY_MINUTES = 4;

export const DEMO_SEEDS: DemoSeedPreset[] = [
  {
    id: "berkeley-claremont-hills-ene",
    label: "Claremont hills brush fire, strong ENE wind",
    blurb:
      "A brush fire in the hills east of Claremont Canyon, pushed downhill by a strong offshore wind. With nobody acting it reaches homes within half an hour and, by hour 6, has burned about 1,255 homes and caught about 800 people. With this seed a scripted initial attack contained the fire at minute 18 with no homes lost, so it shows what a fast dispatch is worth.",
    regionId: BERKELEY_BOARD_ID,
    seed: 1,
    ignitions: [{ lon: -122.218, lat: 37.86, startMinute: 0, reportMinute: REPORT_DELAY_MINUTES }],
    wind: { speedMph: 40, fromDeg: 60 },
    moisturePreset: "critical",
    horizonMinutes: HORIZON_MINUTES,
    measured: { homesBurned: 1255, caughtPeople: 807, atMinute: HORIZON_MINUTES },
  },
  {
    id: "berkeley-grizzly-peak-ene",
    label: "Grizzly Peak hills fire, strong ENE wind (slow build)",
    blurb:
      "A fire in the hills east of Grizzly Peak, driven toward the Berkeley neighbourhoods by a strong offshore wind. It builds slowly: with nobody acting the first homes burn after about two and a half hours, and by hour 6 about 1,000 homes have burned and about 530 people were caught. The slow start leaves time for early, well-sequenced evacuation orders.",
    regionId: BERKELEY_BOARD_ID,
    seed: 1,
    ignitions: [{ lon: -122.218, lat: 37.876, startMinute: 0, reportMinute: REPORT_DELAY_MINUTES }],
    wind: { speedMph: 40, fromDeg: 60 },
    moisturePreset: "critical",
    horizonMinutes: HORIZON_MINUTES,
    measured: { homesBurned: 999, caughtPeople: 534, atMinute: HORIZON_MINUTES },
  },
  {
    id: "berkeley-south-hills-east-wind",
    label: "South Berkeley hills fire, strong east wind",
    blurb:
      "A fire on the slope above the south Berkeley hill neighbourhoods in a strong, almost due-east wind. With nobody acting the first homes burn within half an hour and the first households are caught within two hours; by hour 6 about 1,160 homes have burned and about 780 people were caught. The scripted evacuation advice alone cut the people caught by roughly a quarter to a third across the three seeds tested.",
    regionId: BERKELEY_BOARD_ID,
    seed: 1,
    ignitions: [{ lon: -122.234, lat: 37.868, startMinute: 0, reportMinute: REPORT_DELAY_MINUTES }],
    wind: { speedMph: 40, fromDeg: 80 },
    moisturePreset: "critical",
    horizonMinutes: HORIZON_MINUTES,
    measured: { homesBurned: 1158, caughtPeople: 777, atMinute: HORIZON_MINUTES },
  },
  {
    id: "berkeley-two-spot-ene",
    label: "Two spot fires in the Berkeley hills, ENE wind",
    blurb:
      "Two fires start at once in the Berkeley hills and merge under an east-northeast wind: two fronts for the dispatcher to cover. With nobody acting about 1,110 homes burn and about 1,200 people are caught by hour 6, the most repeatable people-caught figure of the four scenarios (1,161 to 1,206 over three seeds). Scripted evacuation advice alone cut the people caught by more than half in every seed tested.",
    regionId: BERKELEY_BOARD_ID,
    seed: 1,
    ignitions: [
      { lon: -122.234, lat: 37.868, startMinute: 0, reportMinute: REPORT_DELAY_MINUTES },
      { lon: -122.226, lat: 37.876, startMinute: 0, reportMinute: REPORT_DELAY_MINUTES },
    ],
    wind: { speedMph: 35, fromDeg: 60 },
    moisturePreset: "critical",
    horizonMinutes: HORIZON_MINUTES,
    measured: { homesBurned: 1110, caughtPeople: 1206, atMinute: HORIZON_MINUTES },
  },
];

/**
 * The measurements behind `measured` and the blurbs, per board seed 1, 2, 3 (docs/demo-seeds.md
 * has the method, the other candidates and the caveats). All values are from the evaluation
 * harness on each preset's own drill package; none are estimated.
 *
 * - noAction: `--policy none` (no orders, nobody dispatched).
 * - evacuationAdviceOnly: the scripted decision-aid policy (scripts/live-eval/baselinePolicy.ts)
 *   keeping only its evacuation orders. The fire is identical to noAction, so homesBurned does
 *   not change; only people caught does. This is the clean proxy for what better evacuation
 *   decisions buy.
 * - scriptedFull: the whole scripted policy, evacuation plus crews, strategy and extra
 *   resources. CAVEAT: in these runs it burned MORE homes than noAction in all seeds but those
 *   where it contained the fire early, because the board's fire grows faster once crews are
 *   sent (a board behaviour found while measuring; see docs/demo-seeds.md). Do not read it as
 *   what an AI commander achieves.
 */
export interface DemoSeedEvidence {
  seeds: number[];
  noAction: { homesBurned: number[]; caughtPeople: number[]; areaHa: number[] };
  evacuationAdviceOnly: { caughtPeople: number[] };
  scriptedFull: { homesBurned: number[]; caughtPeople: number[]; containedAtMinute: (number | null)[] };
  /** Board minute (10-minute steps) the first home had burned and the first household was caught, no action, per seed. */
  noActionFirstHomeMinute: number[];
  noActionFirstCaughtMinute: number[];
}

export const DEMO_SEED_EVIDENCE: Record<string, DemoSeedEvidence> = {
  "berkeley-claremont-hills-ene": {
    seeds: [1, 2, 3],
    noAction: { homesBurned: [1255, 1357, 1342], caughtPeople: [807, 1394, 903], areaHa: [777.2, 864.7, 856.4] },
    evacuationAdviceOnly: { caughtPeople: [387, 627, 442] },
    scriptedFull: { homesBurned: [0, 2552, 2357], caughtPeople: [0, 1423, 1448], containedAtMinute: [18, null, null] },
    noActionFirstHomeMinute: [30, 20, 20],
    noActionFirstCaughtMinute: [100, 90, 90],
  },
  "berkeley-grizzly-peak-ene": {
    seeds: [1, 2, 3],
    noAction: { homesBurned: [999, 968, 892], caughtPeople: [534, 388, 292], areaHa: [764.3, 736.9, 661.3] },
    evacuationAdviceOnly: { caughtPeople: [258, 203, 154] },
    scriptedFull: { homesBurned: [2857, 3027, 2917], caughtPeople: [1537, 1824, 1601], containedAtMinute: [null, null, null] },
    noActionFirstHomeMinute: [150, 160, 160],
    noActionFirstCaughtMinute: [200, 190, 240],
  },
  "berkeley-south-hills-east-wind": {
    seeds: [1, 2, 3],
    noAction: { homesBurned: [1158, 1126, 1461], caughtPeople: [777, 861, 1007], areaHa: [581.8, 560.5, 736.9] },
    evacuationAdviceOnly: { caughtPeople: [528, 605, 768] },
    scriptedFull: { homesBurned: [1761, 1617, 2445], caughtPeople: [726, 744, 1157], containedAtMinute: [null, null, null] },
    noActionFirstHomeMinute: [30, 30, 20],
    noActionFirstCaughtMinute: [120, 100, 90],
  },
  "berkeley-two-spot-ene": {
    seeds: [1, 2, 3],
    noAction: { homesBurned: [1110, 989, 1170], caughtPeople: [1206, 1193, 1161], areaHa: [668.5, 690.5, 747] },
    evacuationAdviceOnly: { caughtPeople: [541, 509, 532] },
    scriptedFull: { homesBurned: [2045, 2260, 2365], caughtPeople: [778, 1101, 1125], containedAtMinute: [null, null, null] },
    noActionFirstHomeMinute: [70, 70, 60],
    noActionFirstCaughtMinute: [280, 260, 240],
  },
};
