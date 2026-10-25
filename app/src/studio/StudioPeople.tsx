/**
 * Where people are in the Studio evacuation, in plain language: the /live people summary strip
 * (Still home / Driving out / In traffic / Stuck / Out) and, on the 2D map, the /live people
 * layer. Both follow the Studio playback clock: an `EvacuationPlayer` is stepped to the clock's
 * minute and its engine state is turned into a people snapshot (studio/peopleSnapshot.ts).
 * Every value is simulated. The 3D diorama draws the same run with its own overlay.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { PeopleSummary, attachPeopleLayer, type PeopleLayer, type PeopleSnapshot } from "../live/people";
import { EvacuationPlayer, type EvacuationInputs } from "./evacuation";
import { studioPeopleSnapshot } from "./peopleSnapshot";

/** Fewest wall milliseconds between two pictures while the clock runs. */
const MIN_REFRESH_MS = 180;
/** Map layer the people layer goes under (firefighter routes), when present. */
const PEOPLE_BEFORE_LAYER = "studio-crew-routes";

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
  const [snapshot, setSnapshot] = useState<PeopleSnapshot | null>(null);

  // Step the engine to the playback clock and rebuild the picture when the minute changes.
  useEffect(() => {
    // Without a player nothing is shown (the render ignores any earlier snapshot).
    if (!player) return;
    let handle = 0;
    let drawnMinute = Number.NaN;
    let lastWall = -Infinity;
    const build = () =>
      setSnapshot(
        studioPeopleSnapshot(player.engine, {
          cutOff: player.cutOff,
          startMs,
          playbackSpeed: playing ? speed * 60 : 0,
          behavior,
        }),
      );
    const tick = (now: number) => {
      handle = requestAnimationFrame(tick);
      const minute = Math.floor(clockRef.current);
      if (minute === drawnMinute || now - lastWall < MIN_REFRESH_MS) return;
      drawnMinute = minute;
      lastWall = now;
      player.syncTo(minute);
      build();
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [player, clockRef, playing, speed, startMs, behavior]);

  // The /live people layer on the 2D map.
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
    layerRef.current?.update(player ? snapshot : null);
  }, [map, player, snapshot]);

  if (!player && !pending) return null;
  return (
    <PeopleSummary
      snapshot={player ? snapshot : null}
      error={null}
      className="studio-people"
      phonesNote={false}
    />
  );
}
