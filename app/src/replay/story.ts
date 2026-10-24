// Story mode: a short guided walk through the replay, built only from bundle data.
// Each chapter is anchored to a real bundle item (an event, a perimeter or a traffic frame)
// and carries that item's evidence class. Pure: no React, DOM or MapLibre here.
import { VARIANT_CAVEATS, featurable, type VariantIndex } from "./compare";
import { distanceM, inArea } from "./insights";
import { buildCaption, splitSnappedNote } from "./narrative";
import type { ReferencePlace } from "./places";
import { EVACUATION_AREA, baselineAt, hourIndexAt, type Mobility } from "./mobility";
import {
  frameIndexAt,
  localTime,
  ignitionBasis,
  incidentYear,
  observationSource,
  perimeterIndexAt,
  simulatedFrontIndexAt,
} from "./timeline";
import type { AreaGeometry, EvidenceClass, LngLat, ReplayEvent, ReplayModel } from "./types";

export interface Chapter {
  id: string;
  atMs: number;
  title: string;
  body: string;
  evidence: EvidenceClass;
  /** Coordinates the camera frames for this chapter; empty keeps the current view. */
  focus: LngLat[];
  /** The closing what-if comparison instead of a moment on the clock. */
  reveal?: boolean;
}

export interface RevealRow {
  id: string;
  title: string;
  question: string;
  /** Combined exposure (road + home) as a percentage of the baseline run's. */
  exposurePct: number;
  /** Vehicles arrived by 10:00 PST (arrived_by_1800z_veh), when the index has it. */
  arrivedBaseline: number | null;
  arrivedVariant: number | null;
}

const HISTORICAL = new Set<EvidenceClass>(["observed", "reported", "reconstructed", "derived"]);
const MAX_FOCUS_EDGES = 150;
/** Modelled-vehicle chapters are skipped when their headline number is this small. */
const MIN_HEADLINE_VEH = 100;

function ringCoords(g: AreaGeometry): LngLat[] {
  return g.type === "Polygon" ? g.coordinates[0] : g.coordinates.flatMap((poly) => poly[0]);
}

function edgeCoordLookup(model: ReplayModel): Map<string, LngLat[]> {
  return new Map((model.roads?.items ?? []).map((e) => [e.id, e.coords]));
}

function eventCoords(event: ReplayEvent, roads: Map<string, LngLat[]>): LngLat[] {
  return event.edgeIds.flatMap((id) => roads.get(id) ?? []);
}

/** Fire area in effect at t: the observed perimeter if any, else the simulated front. */
function fireAt(model: ReplayModel, t: number): AreaGeometry | null {
  const p = perimeterIndexAt(model, t);
  if (p >= 0) return model.perimeters[p].geometry;
  const s = simulatedFrontIndexAt(model, t);
  return s >= 0 && model.fireSimulated ? model.fireSimulated.fronts[s].geometry : null;
}

function fireCoords(model: ReplayModel, t: number): LngLat[] {
  const g = fireAt(model, t);
  return g ? ringCoords(g) : [];
}

/** Below this modelled mean speed an edge counts as jammed for framing the camera. */
const JAM_KPH = 15;

/**
 * Coordinates of the edges carrying the most modelled vehicles at frame k, optionally only
 * inside `area` and/or only jammed ones.
 */
function busyEdgeCoords(
  model: ReplayModel,
  k: number,
  area: AreaGeometry | null,
  jammedOnly = false,
  near: { coord: LngLat; m: number } | null = null,
): LngLat[] {
  const traffic = model.traffic;
  if (!traffic || k < 0) return [];
  const roads = edgeCoordLookup(model);
  const out: LngLat[] = [];
  let taken = 0;
  const edges = [...traffic.frames[k].edges].sort((a, b) => b[1] - a[1]);
  for (const [index, veh, speed] of edges) {
    if (veh <= 0 || taken >= MAX_FOCUS_EDGES) break;
    if (jammedOnly && speed >= JAM_KPH) continue;
    const coords = roads.get(traffic.edgeIds[index]);
    if (!coords || coords.length === 0) continue;
    const mid = coords[Math.floor(coords.length / 2)];
    if (area && !inArea(area, mid)) continue;
    if (near && distanceM(near.coord, mid) > near.m) continue;
    out.push(...coords);
    taken += 1;
  }
  return out;
}

/** Hours after ignition compared with a normal week, for the device-data chapter. */
const MOBILITY_WINDOW_START_H = 2;
const MOBILITY_WINDOW_H = 8;
/** Only a strong drop makes a chapter: visits at most this share of normal. */
const MOBILITY_MAX_RATIO = 0.5;

/**
 * Device-data beat: visits to places in the evacuation area in the hours after ignition,
 * against the same hours of the baseline week. Null when the sidecar, the series or a clear
 * drop is missing.
 */
function mobilityChapter(model: ReplayModel, m: Mobility | null): Chapter | null {
  const ignitionMs = model.fireSimulated?.ignition?.atMs;
  if (!m || ignitionMs == null) return null;
  const series = m.series.find((s) => s.region === EVACUATION_AREA && s.category === "all");
  const i0 = hourIndexAt(m, ignitionMs + MOBILITY_WINDOW_START_H * 3_600_000);
  if (!series || i0 < 0 || i0 + MOBILITY_WINDOW_H > m.hourStartsMs.length) return null;
  let visits = 0;
  let normal = 0;
  for (let i = i0; i < i0 + MOBILITY_WINDOW_H; i += 1) {
    visits += series.visits[i];
    normal += baselineAt(series.baseline, i);
  }
  if (normal <= 0 || visits / normal > MOBILITY_MAX_RATIO) return null;
  const tz = model.incident.timezone;
  const from = localTime(m.hourStartsMs[i0], tz);
  const to = localTime(m.hourStartsMs[i0 + MOBILITY_WINDOW_H - 1] + 3_600_000, tz);
  return {
    id: "mobility",
    atMs: m.hourStartsMs[i0 + Math.floor(MOBILITY_WINDOW_H / 2)],
    title: visits / normal <= 0.25 ? "The town empties" : "Fewer people out and about",
    body:
      `Visits to ${fmt(series.poiCount)} places in the evacuation area from ${from} to ${to} were ` +
      `${Math.round((visits / normal) * 100)}% of the same hours in a normal week` +
      (m.baselineWeeks[0] ? ` (week of ${m.baselineWeeks[0]})` : "") +
      ". Derived from phone-panel data (Advan via Dewey): visits to places, not a count of people.",
    evidence: m.evidenceClass,
    focus: [],
  };
}

/** Ensure a closing full stop, unless `close` is false (then strip one). */
function sentence(text: string, close = true): string {
  const trimmed = text.trim().replace(/[.]+$/, "");
  return close ? `${trimmed}.` : trimmed;
}

/** NIST fire observations seen in the half hour before t, for framing the camera. */
function observationCoords(model: ReplayModel, t: number): LngLat[] {
  return (model.fireObservations?.items ?? [])
    .filter((o) => o.atMs <= t && o.atMs > t - 30 * 60_000)
    .map((o) => o.coord);
}

function argmax(values: number[]): number {
  let best = -1;
  for (let i = 0; i < values.length; i += 1) if (best < 0 || values[i] > values[best]) best = i;
  return best;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function firstEvent(model: ReplayModel, test: (e: ReplayEvent) => boolean): ReplayEvent | null {
  return model.events.find(test) ?? null;
}

function isOrder(e: ReplayEvent): boolean {
  return (
    HISTORICAL.has(e.evidenceClass) &&
    (e.type === "evacuation_order" || e.type === "alert_sent") &&
    /\border\b/i.test(e.label)
  );
}

/** Chapters in clock order. Chapters whose source data is absent are simply left out. */
export function buildChapters(
  model: ReplayModel,
  variants: VariantIndex | null,
  place: ReferencePlace | null,
  mobility: Mobility | null = null,
): Chapter[] {
  const chapters: Chapter[] = [];
  const obs = observationSource(model);
  const roads = edgeCoordLookup(model);

  const fireLine = (t: number) => {
    const fire = buildCaption(model, t, frameIndexAt(model, t), place).fire;
    if (!fire) return "";
    // Caption fragments ("model fire 12.0 km from Paradise") as a full sentence.
    const text = fire
      .replace(/^model fire has/, "the modelled fire has")
      .replace(/^model fire /, "the modelled fire is ")
      .replace(/^satellite perimeter /, "the satellite perimeter is ");
    return ` At this moment ${text}.`;
  };

  // Prologue: where people were before anyone left (Census households; the people layer).
  const zones = model.zones?.items ?? [];
  const households = zones.reduce((sum, z) => sum + (z.households ?? 0), 0);
  const people = model.demand?.population ?? null;
  const startAt = model.fireSimulated?.ignition?.atMs ?? model.clock.startMs;
  if (households > 0) {
    const zoneEvidence = model.zones?.evidenceClass;
    chapters.push({
      id: "people",
      atMs: Math.max(model.clock.startMs, startAt - 60_000),
      title: "Where people were at ignition",
      body:
        (people != null ? `${fmt(people)} people in ` : "") +
        `${fmt(households)} households across ${fmt(zones.length)} Census areas. ` +
        "Lighter grey means more households per km². Watch it drain as people leave.",
      evidence: zoneEvidence && zoneEvidence !== "mixed" ? zoneEvidence : "derived",
      focus: zones.flatMap((z) => ringCoords(z.geometry)),
    });
  }

  // Opening: the first 911 report when the bundle has it, else the ignition record.
  const ignition = firstEvent(model, (e) => e.type === "fire_ignition");
  const reported = firstEvent(
    model,
    (e) => e.type === "fire_reported" && HISTORICAL.has(e.evidenceClass),
  );
  const opening = reported ?? ignition;
  const ignitionCoord = model.fireSimulated?.ignition?.coord ?? null;
  const basis = ignitionBasis(model);
  if (opening) {
    chapters.push({
      id: "ignition",
      atMs: opening.atMs,
      title: reported
        ? "The fire is reported"
        : sentence(splitSnappedNote(opening.label).text, false),
      body:
        (reported && ignition
          ? `${sentence(splitSnappedNote(reported.label).text)} ${sentence(ignition.label)} `
          : "") +
        `Until the first satellite image, the orange area is a model fire from the ${basis} ignition.`,
      evidence: opening.evidenceClass,
      focus: [...(ignitionCoord ? [ignitionCoord] : []), ...(place ? [place.coord] : [])],
    });
  }

  const order = firstEvent(model, isOrder);
  const placeOrderFirst = place
    ? firstEvent(model, (e) => isOrder(e) && e.label.includes(place.name))
    : null;
  // When the reference place has its own order, that chapter carries the story instead.
  if (order && (!placeOrderFirst || placeOrderFirst.id === order.id)) {
    chapters.push({
      id: "first-order",
      atMs: order.atMs,
      title: "First evacuation order",
      body: `${sentence(splitSnappedNote(order.label).text)}${fireLine(order.atMs)}`,
      evidence: order.evidenceClass,
      focus: [...fireCoords(model, order.atMs), ...(place ? [place.coord] : [])],
    });
  }

  if (place) {
    const placeOrder = firstEvent(model, (e) => isOrder(e) && e.label.includes(place.name));
    if (placeOrder && placeOrder.id !== order?.id) {
      chapters.push({
        id: "place-order",
        atMs: placeOrder.atMs,
        title: `${place.name} is ordered out`,
        body: `${sentence(splitSnappedNote(placeOrder.label).text)}${fireLine(placeOrder.atMs)}`,
        evidence: placeOrder.evidenceClass,
        focus: [...fireCoords(model, placeOrder.atMs), place.coord],
      });
    }

    // The first documented fire in the place, from the record, and how soon after its first order.
    const arrival = firstEvent(
      model,
      (e) =>
        e.type === "fire_arrival" &&
        HISTORICAL.has(e.evidenceClass) &&
        e.label.includes(place.name),
    );
    if (arrival) {
      const gapMin = placeOrder ? Math.round((arrival.atMs - placeOrder.atMs) / 60_000) : null;
      chapters.push({
        id: "place-fire",
        atMs: arrival.atMs,
        title: `Fire reaches ${place.name}`,
        body:
          sentence(splitSnappedNote(arrival.label).text) +
          (gapMin !== null && gapMin >= 0
            ? ` That is ${gapMin} minute${gapMin === 1 ? "" : "s"} after the first order for ${place.name}.`
            : "") +
          "",
        evidence: arrival.evidenceClass,
        focus: [...observationCoords(model, arrival.atMs), place.coord],
      });
    }
  }

  // A modelled entrapment, set against the recorded burnovers it is compared with.
  const trapped = firstEvent(model, (e) => e.type === "vehicles_trapped");
  if (trapped) {
    const burnovers = model.events.filter(
      (e) => e.type === "burnover" && HISTORICAL.has(e.evidenceClass),
    );
    const row = model.validation?.rows.find((r) => r.metric === "identified_burnovers");
    const coords = eventCoords(trapped, roads);
    chapters.push({
      id: "trapped",
      atMs: trapped.atMs,
      title: "Trapped by fire (model)",
      body:
        sentence(splitSnappedNote(trapped.label).text) +
        (burnovers.length > 0
          ? ` In ${incidentYear(model)}, ${row?.published ?? burnovers.length} burnovers were recorded; the first in this replay: ` +
            `${sentence(splitSnappedNote(burnovers[0].label).text, false)} (reconstructed).`
          : "") +
        (row?.comparability === "tuned"
          ? " The model was tuned to that count, so the match is not validation."
          : ""),
      evidence: trapped.evidenceClass,
      focus: [...coords, ...fireCoords(model, trapped.atMs)],
    });
  }

  const traffic = model.traffic;

  const contraflow = firstEvent(
    model,
    (e) => e.type === "contraflow_started" && HISTORICAL.has(e.evidenceClass),
  );
  if (contraflow) {
    chapters.push({
      id: "contraflow",
      atMs: contraflow.atMs,
      title: "Contraflow: every lane outbound",
      body: sentence(splitSnappedNote(contraflow.label).text),
      evidence: contraflow.evidenceClass,
      focus: eventCoords(contraflow, roads),
    });
  }

  const blocked = firstEvent(
    model,
    (e) =>
      e.type === "road_blocked" && HISTORICAL.has(e.evidenceClass) && /fire|burning/i.test(e.label),
  );
  if (blocked) {
    const coords = eventCoords(blocked, roads);
    chapters.push({
      id: "road-blocked",
      atMs: blocked.atMs,
      title: "Fire cuts an escape road",
      body: sentence(splitSnappedNote(blocked.label).text),
      evidence: blocked.evidenceClass,
      focus: [...coords, ...fireCoords(model, blocked.atMs)],
    });
  }

  if (traffic && traffic.metrics.length > 0) {
    const k = argmax(traffic.metrics.map((m) => m.exposedVeh));
    const m = traffic.metrics[k];
    if (m.exposedVeh >= MIN_HEADLINE_VEH) {
      chapters.push({
        id: "peak-exposure",
        atMs: m.atMs,
        title: "Cars inside the fire",
        body:
          `Modelled peak: ${fmt(m.exposedVeh)} vehicles on roads inside the fire area, ` +
          `${fmt(m.notDepartedVeh + m.enRouteVeh)} of ${fmt(m.notDepartedVeh + m.enRouteVeh + m.arrivedVeh)} not yet out.`,
        evidence: traffic.evidenceClass,
        focus: [
          ...busyEdgeCoords(model, k, fireAt(model, m.atMs)),
          ...(place ? [place.coord] : []),
        ],
      });
    }
  }

  const perimeter = model.perimeters[0];
  if (perimeter) {
    const iou = model.fireSimulated?.calibrationIou;
    const check = model.fireSimulated?.calibrationHeadline;
    chapters.push({
      id: "satellite",
      atMs: perimeter.atMs,
      title: `First satellite perimeter${perimeter.areaKm2 != null ? `: ${perimeter.areaKm2.toFixed(0)} km²` : ""}`,
      body:
        "The dashed line is the satellite estimate; from here it replaces the model fire." +
        (check ? ` Model check against ${obs} observations: ${check}.` : "") +
        (iou != null ? ` Perimeter overlap (IoU) ${iou.toFixed(2)}, evaluation only.` : ""),
      evidence: perimeter.evidenceClass,
      focus: ringCoords(perimeter.geometry),
    });
  }

  // Generic beats for bundles without the place-specific ones (e.g. multi-town fires).
  const core = () => chapters.length;
  if (!chapters.some((c) => c.id === "place-fire")) {
    const arrival = firstEvent(
      model,
      (e) => e.type === "fire_arrival" && HISTORICAL.has(e.evidenceClass),
    );
    if (arrival) {
      chapters.push({
        id: "fire-arrival",
        atMs: arrival.atMs,
        title: "Fire reaches homes",
        body: sentence(splitSnappedNote(arrival.label).text),
        evidence: arrival.evidenceClass,
        focus: fireCoords(model, arrival.atMs),
      });
    }
  }
  if (traffic && traffic.metrics.length > 0 && core() < 8) {
    const k = argmax(traffic.metrics.map((m) => m.enRouteVeh));
    const m = traffic.metrics[k];
    if (m.enRouteVeh >= MIN_HEADLINE_VEH) {
      const lastOrder = [...model.events].reverse().find((e) => e.atMs <= m.atMs && isOrder(e));
      chapters.push({
        id: "peak-traffic",
        atMs: m.atMs,
        title: "Everyone on the road",
        body:
          `Modelled peak: ${fmt(m.enRouteVeh)} vehicles on the road at once, ${fmt(m.blockedVeh)} unable to move.` +
          (lastOrder
            ? ` Latest order before this: ${sentence(splitSnappedNote(lastOrder.label).text, false)}.`
            : ""),
        evidence: traffic.evidenceClass,
        focus: busyEdgeCoords(model, k, null),
      });
    }
  }
  const shelter = firstEvent(
    model,
    (e) => e.type === "shelter_opened" && HISTORICAL.has(e.evidenceClass),
  );
  if (shelter && core() < 8 && !/^Temporary refuge|^TRA-/i.test(shelter.label)) {
    chapters.push({
      id: "shelter",
      atMs: shelter.atMs,
      title: "A place to go",
      body: sentence(splitSnappedNote(shelter.label).text),
      evidence: shelter.evidenceClass,
      focus: [],
    });
  }

  const emptied = mobilityChapter(model, mobility);
  if (emptied) chapters.push(emptied);

  chapters.sort((a, b) => a.atMs - b.atMs);

  if (variants && revealRows(variants).length > 0) {
    chapters.push({
      id: "what-if",
      // The map sits at the modelled worst moment while the alternatives are compared.
      atMs:
        chapters.find((c) => c.id === "peak-exposure")?.atMs ??
        chapters[chapters.length - 1]?.atMs ??
        model.clock.startMs,
      title: "Could it have gone differently?",
      body:
        "The same modelled morning, re-run with one change each. Bars: exposure to fire on roads and at home, " +
        "relative to the baseline (shorter is better). Planning experiments, not history.",
      evidence: "simulated",
      focus: chapters.find((c) => c.id === "peak-exposure")?.focus ?? [],
      reveal: true,
    });
  }
  return chapters;
}

/**
 * Featurable variants (not flagged as artifact, noise or worse at home) with a combined-exposure headline,
 * lowest exposure first.
 */
export function revealRows(index: VariantIndex): RevealRow[] {
  const rows: RevealRow[] = [];
  for (const v of index.variants) {
    // A road-only gain bought with worse exposure at home is not a result to feature here;
    // the What if… tab shows it with the full road / home breakdown.
    if (!featurable(v.id) || VARIANT_CAVEATS[v.id]?.kind === "worse-at-home") continue;
    const h = v.headline.total_exposed_veh_min;
    if (!h || h.baseline == null || h.variant == null || h.baseline <= 0) continue;
    const a = v.headline.arrived_by_1800z_veh;
    rows.push({
      id: v.id,
      title: v.title,
      question: v.question,
      exposurePct: (h.variant / h.baseline) * 100,
      arrivedBaseline: a?.baseline ?? null,
      arrivedVariant: a?.variant ?? null,
    });
  }
  return rows.sort((a, b) => a.exposurePct - b.exposurePct);
}
