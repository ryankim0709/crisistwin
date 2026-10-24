/**
 * Demo scenario in the East Bay hills (Orinda/Moraga side of the Berkeley hills, around
 * 37.87, -122.20), retuned for visible spread under a 20 mph NE wind, the "critical"
 * moisture preset and a 3 h horizon. The coordinates are ILLUSTRATIVE and not a real
 * incident. The earlier points sat on timber litter under canopy and barely spread.
 *
 * Points, fuels (LANDFIRE FBFM40) and head rate at the point:
 * - F1 (T+0):  37.87509, -122.19607  GR2 grass,      30.8 m/min
 * - F2 (T+20): 37.85722, -122.20361  SH5 shrub,      36.1 m/min
 * - F3 (T+45): 37.86616, -122.21116  GR2 grass,      24.6 m/min; downwind (SW) of F1
 *
 * Measured with the scheduled solver on the real landscape box for these points (LANDFIRE
 * LF2025, run on 2026-10-24; numbers can change if the source data changes):
 * - with crown fire carry through continuous canopy (ADR 0008, merged from main): combined
 *   footprint 288 ha at T+60, 2,489 ha at T+120, 4,549 ha at T+180;
 * - F1 reaches F3's point at T+34.2, before F3's T+45 start (run outcome
 *   "reached-before-start");
 * - before crown carry the same points gave 152 ha at T+60 and 916 ha at T+180, with F3
 *   reached at T+38.9;
 * - no reachedEdgeMinute (the fire never touches the landscape edge).
 */

import { MOISTURE_PRESETS } from "../fire/spread";
import type { StudioScenario } from "./contracts";
import { emptyScenario } from "./scenario";

export function demoScenario(): StudioScenario {
  const base = emptyScenario();
  const critical = MOISTURE_PRESETS.find((preset) => preset.id === "critical");
  return {
    ...base,
    name: "Three fires (illustrative demo)",
    ignitions: [
      {
        id: crypto.randomUUID(),
        name: "F1",
        location: { latitude: 37.87509, longitude: -122.19607 },
        startMinute: 0,
        enabled: true,
      },
      {
        id: crypto.randomUUID(),
        name: "F2",
        location: { latitude: 37.85722, longitude: -122.20361 },
        startMinute: 20,
        enabled: true,
      },
      {
        id: crypto.randomUUID(),
        name: "F3",
        location: { latitude: 37.86616, longitude: -122.21116 },
        startMinute: 45,
        enabled: true,
      },
    ],
    settings: {
      ...base.settings,
      windSpeedMph: 20,
      windFromDegrees: 45,
      ...(critical ? { moisture: { ...critical.moisture } } : {}),
      horizonMinutes: 180,
    },
  };
}
