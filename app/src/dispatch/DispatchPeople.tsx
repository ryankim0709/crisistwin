/**
 * Where people are in the /dispatch run: the shared population view (src/population) drawn from
 * the dispatch session's own engine (the one the AI dispatcher's orders act on), rebuilt on every
 * session step, so ordered zones visibly leave, staged waves release and closures reroute. The
 * strip goes in the studio dock, the people layer on the 2D map; the 3D diorama draws the same
 * engine with DispatchOverlay (house roofs by state, cars on the road).
 *
 * Before a session the view shows an engine with no orders at T+0 (who lives where). The engine
 * has no self-evacuation: households leave only once their zone is ordered, and the strip says
 * so until then. Every value is simulated.
 */

import { useMemo } from "react";
import { createPortal } from "react-dom";
import type { Map as MapLibreMap } from "maplibre-gl";
import { PopulationView, type ZoneHouseholds } from "../population";
import type { DispatchArea } from "./area";
import { DispatchEngine } from "./engine";
import type { FireExposure } from "./fireExposure";
import type { SessionStatus } from "./useDispatchSession";

export interface DispatchPeopleProps {
  map: MapLibreMap | null;
  /** Studio dock slot for the strip; nothing is drawn without it. */
  dock: HTMLElement | null;
  area: DispatchArea | null;
  exposure: FireExposure | null;
  horizonMinutes: number;
  closedEdges: ReadonlySet<number>;
  /** The running session's engine, or null before a session. */
  engine: DispatchEngine | null;
  /** Bumped on every session step. */
  version: number;
  status: SessionStatus;
  /** Session speed, simulated minutes per wall second. */
  speed: number;
  /** Wall-clock time of T+0, epoch ms. */
  startMs: number;
  /** `basis.people_behavior` label. */
  behavior: string;
  zonePeople: ZoneHouseholds | null;
  /** True while the snapshot households are loading. */
  householdsLoading: boolean;
}

export default function DispatchPeople({
  map,
  dock,
  area,
  exposure,
  horizonMinutes,
  closedEdges,
  engine,
  version,
  status,
  speed,
  startMs,
  behavior,
  zonePeople,
  householdsLoading,
}: DispatchPeopleProps) {
  const preview = useMemo(
    () =>
      !engine && area && exposure && area.zones.length > 0
        ? new DispatchEngine(area, exposure, horizonMinutes, [], closedEdges)
        : null,
    [engine, area, exposure, horizonMinutes, closedEdges],
  );
  if (!dock || !area || area.zones.length === 0) return null;
  const moving = engine !== null && (status === "running" || status === "thinking");
  const ordered = engine?.zones.some((zone) => zone.status !== "no_order" || zone.stage) ?? false;
  const note = !engine
    ? "Waiting for an evacuation order. Start the AI dispatcher to send one."
    : !ordered
      ? "Waiting for an evacuation order. Households leave only once their zone is ordered."
      : householdsLoading
        ? "Loading household data…"
        : null;
  return createPortal(
    <PopulationView
      map={map}
      engine={engine ?? preview}
      version={version}
      startMs={startMs}
      playbackSpeed={moving ? speed * 60 : 0}
      behavior={behavior}
      zonePeople={zonePeople}
      pending
      note={note}
    />,
    dock,
  );
}
