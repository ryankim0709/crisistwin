/**
 * Where people are in the Studio evacuation: the shared population view (src/population) for an
 * `EvacuationPlayer` stepped to the Studio playback clock, with the area's snapshot households
 * when a scenario snapshot covers it. /dispatch draws its own session engine with the same view.
 * Every value is simulated. The 3D diorama draws the same run with its own overlay.
 */

import { useMemo } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { PopulationView, useClockSteppedPlayer, useZoneHouseholds } from "../population";
import { EvacuationPlayer, type EvacuationInputs } from "./evacuation";

export interface StudioPeopleProps {
  /** The Studio's MapLibre map while the Map view is shown, else null (strip only). */
  map: MapLibreMap | null;
  /** The evacuation being played, or null when there is none to show. */
  inputs: EvacuationInputs | null;
  /** True while an evacuation is expected but not ready (roads loading). */
  pending: boolean;
  clockRef: { readonly current: number };
  playing: boolean;
  /** Simulated minutes per wall second. */
  speed: number;
  /** Wall-clock time of T+0, epoch ms. */
  startMs: number;
  /** `basis.people_behavior` label. */
  behavior: string;
}

export default function StudioPeople({
  map,
  inputs,
  pending,
  clockRef,
  playing,
  speed,
  startMs,
  behavior,
}: StudioPeopleProps) {
  const player = useMemo(() => (inputs ? new EvacuationPlayer(inputs) : null), [inputs]);
  const version = useClockSteppedPlayer(player, clockRef);
  const households = useZoneHouseholds(inputs?.area ?? null);
  return (
    <PopulationView
      map={map}
      engine={player ? player.engine : null}
      version={version}
      cutOff={player?.cutOff}
      startMs={startMs}
      playbackSpeed={playing ? speed * 60 : 0}
      behavior={behavior}
      zonePeople={households.zones}
      pending={pending}
    />
  );
}
