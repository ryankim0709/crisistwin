/**
 * Illustrative demo scenario near the /fire default area (Berkeley/Oakland hills, centre
 * 37.88, -122.24). The coordinates are ILLUSTRATIVE: chosen to be roughly 1-2 km apart in
 * hillside vegetation, with F3 about 2 km downwind (SW-ward) of F1 under a 20 mph NE wind
 * so F1 may reach it before T+45. They are not calibrated and not a real incident; tune
 * after running against the live landscape.
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
        location: { latitude: 37.8855, longitude: -122.2345 },
        startMinute: 0,
        enabled: true,
      },
      {
        id: crypto.randomUUID(),
        name: "F2",
        location: { latitude: 37.8735, longitude: -122.2375 },
        startMinute: 20,
        enabled: true,
      },
      {
        id: crypto.randomUUID(),
        name: "F3",
        location: { latitude: 37.8715, longitude: -122.2535 },
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
