/**
 * The population picture of a dispatch engine: the /live people summary strip (Still home /
 * Driving out / In traffic / Stuck / Out) and, on a 2D MapLibre map, the /live people layer.
 * The caller owns the engine and its clock (Studio steps an EvacuationPlayer to its playback
 * clock with `useClockSteppedPlayer`; /dispatch passes its live session engine) and bumps
 * `version` whenever the engine changed. The picture is rebuilt from the engine
 * (peopleSnapshot.ts) on each bump. Every value is simulated.
 */

import { useEffect, useMemo, useRef, type ReactNode } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { PeopleSummary, attachPeopleLayer, type PeopleLayer } from "../live/people";
import type { DispatchEngine } from "../dispatch/engine";
import type { ZoneHouseholds } from "./households";
import { studioPeopleSnapshot } from "./peopleSnapshot";

/** Map layer the people layer goes under (Studio firefighter routes), when present. */
export const PEOPLE_BEFORE_LAYER = "studio-crew-routes";
const NO_CUT_OFF: ReadonlySet<number> = new Set();

export interface PopulationViewProps {
  /** The 2D map to draw the people layer on, or null (strip only). */
  map: MapLibreMap | null;
  /** The engine at the minute to show, or null when there is none. */
  engine: DispatchEngine | null;
  /** Bumped whenever the engine changed (it steps in place). */
  version: number;
  /** Zones found with no exit when the order went out (Studio policy). */
  cutOff?: ReadonlySet<number>;
  /** Wall-clock time of T+0, epoch ms. */
  startMs: number;
  /** Simulated seconds per wall second while the clock runs; 0 when paused. */
  playbackSpeed: number;
  /** `basis.people_behavior` label (householdBehavior.ts `behaviorLabel`). */
  behavior: string;
  /** Snapshot households per zone (useZoneHouseholds), or null for the synthetic estimate. */
  zonePeople: ZoneHouseholds | null;
  /** Show the strip in its loading state while no engine is ready yet. */
  pending?: boolean;
  /** One plain-language line after the counts. */
  note?: ReactNode;
  className?: string;
}

export default function PopulationView({
  map,
  engine,
  version,
  cutOff = NO_CUT_OFF,
  startMs,
  playbackSpeed,
  behavior,
  zonePeople,
  pending = false,
  note,
  className = "studio-people",
}: PopulationViewProps) {
  const snapshot = useMemo(
    () =>
      engine
        ? studioPeopleSnapshot(engine, { cutOff, startMs, playbackSpeed, behavior, zonePeople })
        : null,
    // version: the engine steps in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, version, cutOff, startMs, playbackSpeed, behavior, zonePeople],
  );

  const layerRef = useRef<PeopleLayer | null>(null);
  useEffect(() => {
    if (!map) return;
    const layer = attachPeopleLayer(map, PEOPLE_BEFORE_LAYER);
    layerRef.current = layer;
    return () => {
      layer.dispose();
      layerRef.current = null;
    };
  }, [map]);
  useEffect(() => {
    layerRef.current?.update(snapshot);
  }, [map, snapshot]);

  if (!engine && !pending) return null;
  return (
    <PeopleSummary
      snapshot={snapshot}
      error={null}
      className={className}
      phonesNote={false}
      note={note}
    />
  );
}
