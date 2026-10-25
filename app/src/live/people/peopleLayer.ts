/**
 * MapLibre "people" layer: the simulated population picture (docs/twin-api.md "People snapshot").
 *
 * - Still home: a graduated circle per zone, area by residents still home (with or without a car).
 * - Driving out: dots flowing along each occupied road edge in its travel direction. One dot is a
 *   fixed number of people (`peoplePerDot`); dots move at the edge's simulated speed, sped up by
 *   `MOTION_SCALE` so motion is visible between polls, and freeze while the drill clock is paused.
 * - Waiting in traffic / stuck: the edge drawn in yellow / pink with dots packed at its far end; stuck
 *   clusters carry a plain-language label ("900 stuck on Ridge Road: in traffic 15+ min").
 * - Out: a circle per destination with the people who reached it.
 *
 * Self-contained: `attachPeopleLayer(map, beforeId)` adds its sources, layers, popup and animation and
 * returns `update`, `setVisible` and `dispose`, so any MapLibre map (the /live command map, an app
 * integration view) can host it. Everything it draws is simulated.
 */
import { Popup, type GeoJSONSource, type Map as MapLibreMap, type MapLayerMouseEvent } from "maplibre-gl";
import type { LonLat } from "../types";
import { PEOPLE_COLOR as C } from "./palette";
import type { PeopleEdgeRow, PeopleSnapshot } from "./types";

/** Display speed of moving dots relative to simulated speed. */
export const MOTION_SCALE = 30;
const MAX_DOTS = 3500;
const DOT_STEPS = [2, 3, 5, 10, 20, 50, 100, 200];
const FRAME_MS = 66;
/** Spacing of packed dots in a queue, metres. */
const QUEUE_SPACING_M = 22;
/** Moving dots never crawl slower than this on screen (m/s simulated), so a slow road still reads as moving. */
const MIN_SPEED_MS = 1.5;

const SRC = {
  homes: "ppl-homes",
  roads: "ppl-roads",
  dots: "ppl-dots",
  points: "ppl-points",
  out: "ppl-out",
  stuck: "ppl-stuck",
} as const;

export const PEOPLE_LAYER_IDS = [
  "ppl-homes",
  "ppl-homes-label",
  "ppl-roads-casing",
  "ppl-roads",
  "ppl-points",
  "ppl-dots",
  "ppl-out",
  "ppl-out-label",
  "ppl-stuck",
  "ppl-stuck-label",
];
/** Layers with a popup; a host map should skip its own click handling on these. */
export const PEOPLE_INTERACTIVE_LAYERS = ["ppl-homes", "ppl-roads", "ppl-points", "ppl-out", "ppl-stuck"];

export interface PeopleLayer {
  update(snapshot: PeopleSnapshot | null): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

type Props = Record<string, string | number | boolean | null>;
type Feature = GeoJSON.Feature<GeoJSON.Geometry, Props>;
const fc = (features: Feature[]): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features });
const pt = (coord: LonLat, properties: Props): Feature => ({ type: "Feature", geometry: { type: "Point", coordinates: coord }, properties });

const nf = (n: number) => Math.round(n).toLocaleString("en-US");

/** People represented by one dot: the smallest step that keeps the dots on the road under MAX_DOTS. */
export function peoplePerDot(snapshot: PeopleSnapshot): number {
  const t = snapshot.totals.people;
  const onRoad = t.driving + t.queued + t.stuck;
  return DOT_STEPS.find((s) => onRoad / s <= MAX_DOTS) ?? DOT_STEPS[DOT_STEPS.length - 1];
}

interface EdgeGeom {
  pts: LonLat[];
  cum: number[];
  len: number;
}

function edgeGeom(line: LonLat[]): EdgeGeom {
  const cum = [0];
  const kx = Math.cos(((line[0]?.[1] ?? 0) * Math.PI) / 180) * 111_320;
  for (let i = 1; i < line.length; i++) {
    const dx = (line[i][0] - line[i - 1][0]) * kx;
    const dy = (line[i][1] - line[i - 1][1]) * 111_320;
    cum.push(cum[i - 1] + Math.hypot(dx, dy));
  }
  return { pts: line, cum, len: cum[cum.length - 1] };
}

/** Point at fraction f (0..1) of the line's length. */
function along(g: EdgeGeom, f: number): LonLat {
  const d = Math.min(Math.max(f, 0), 1) * g.len;
  let i = 1;
  while (i < g.cum.length - 1 && g.cum[i] < d) i++;
  const seg = g.cum[i] - g.cum[i - 1];
  const u = seg > 0 ? (d - g.cum[i - 1]) / seg : 0;
  const a = g.pts[i - 1];
  const b = g.pts[i];
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
}

/** Stable pseudo-random phase per edge, so dots on neighbouring edges do not line up. */
const phaseOf = (i: number) => (Math.imul(i + 1, 2654435761) >>> 0) / 4294967296;

interface MovingEdge {
  g: EdgeGeom;
  n: number;
  speedMs: number;
  phase: number;
}

const DOT_STATE = { driving: 0, queued: 1, stuck: 2 } as const;

function packed(g: EdgeGeom, n: number, state: number, out: Feature[]): void {
  if (n <= 0 || g.len <= 0) return;
  const step = Math.min(1 / n, QUEUE_SPACING_M / g.len);
  for (let k = 0; k < n; k++) out.push(pt(along(g, 1 - (k + 0.5) * step), { s: state }));
}

const REASON_SHORT: Record<string, string> = {
  long_queue: "in traffic 15+ min",
  road_closed: "road closed ahead",
  fire: "cut off by fire",
  no_route: "no open way out",
  turned_back: "turned back",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function col(fields: string[], name: string, fallback: number): number {
  const i = fields.indexOf(name);
  return i >= 0 ? i : fallback;
}

export function attachPeopleLayer(map: MapLibreMap, beforeId?: string): PeopleLayer {
  const before = beforeId && map.getLayer(beforeId) ? beforeId : undefined;
  for (const id of Object.values(SRC)) map.addSource(id, { type: "geojson", data: fc([]) });
  const add = (layer: Parameters<MapLibreMap["addLayer"]>[0]) => map.addLayer(layer, before);
  const byPeople = (min: number, max: number) =>
    ["interpolate", ["linear"], ["sqrt", ["get", "people"]], 1, min, 30, (min + max) / 2, 80, max] as never;

  add({
    id: "ppl-homes",
    type: "circle",
    source: SRC.homes,
    paint: {
      "circle-radius": byPeople(4, 26),
      "circle-color": C.home,
      "circle-opacity": 0.38,
      "circle-stroke-color": C.homeEdge,
      "circle-stroke-width": 1.5,
    },
  });
  add({
    id: "ppl-roads-casing",
    type: "line",
    source: SRC.roads,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": C.halo,
      "line-opacity": 0.7,
      "line-width": ["interpolate", ["linear"], ["get", "people"], 1, 5, 50, 8, 400, 13] as never,
    },
  });
  add({
    id: "ppl-roads",
    type: "line",
    source: SRC.roads,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["match", ["get", "state"], "stuck", C.stuck, C.queued] as never,
      "line-opacity": 0.85,
      "line-width": ["interpolate", ["linear"], ["get", "people"], 1, 3, 50, 5.5, 400, 10] as never,
    },
  });
  add({
    id: "ppl-points",
    type: "circle",
    source: SRC.points,
    paint: {
      "circle-radius": byPeople(3, 9),
      "circle-color": ["match", ["get", "state"], "stuck", C.stuck, C.queued] as never,
      "circle-stroke-color": C.ink,
      "circle-stroke-width": 1,
    },
  });
  add({
    id: "ppl-dots",
    type: "circle",
    source: SRC.dots,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 1.8, 13, 3, 16, 4.5] as never,
      "circle-color": ["match", ["get", "s"], 2, C.stuck, 1, C.queued, C.driving] as never,
      "circle-stroke-color": ["match", ["get", "s"], 2, C.stuckEdge, 1, C.queuedEdge, C.drivingEdge] as never,
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 10, 0.4, 14, 0.9] as never,
    },
  });
  add({
    id: "ppl-out",
    type: "circle",
    source: SRC.out,
    paint: {
      "circle-radius": byPeople(5, 20),
      "circle-color": C.out,
      "circle-opacity": 0.75,
      "circle-stroke-color": C.halo,
      "circle-stroke-width": 2,
    },
  });
  add({
    id: "ppl-stuck",
    type: "circle",
    source: SRC.stuck,
    paint: {
      "circle-radius": byPeople(6, 22),
      "circle-color": C.stuck,
      "circle-opacity": 0.18,
      "circle-stroke-color": C.stuck,
      "circle-stroke-width": 2.5,
    },
  });
  const label = (id: string, source: string, color: string, extra: Record<string, unknown> = {}) =>
    add({
      id,
      type: "symbol",
      source,
      layout: {
        "text-field": ["get", "text"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 12,
        "text-offset": [0, 1.3],
        "text-anchor": "top",
        "text-max-width": 14,
        "symbol-sort-key": ["-", 0, ["get", "people"]],
        ...extra,
      } as never,
      paint: { "text-color": color, "text-halo-color": C.halo, "text-halo-width": 1.8 },
    });
  label("ppl-homes-label", SRC.homes, C.homeEdge, { "text-size": 11, "text-offset": [0, 0], "text-anchor": "center" });
  label("ppl-out-label", SRC.out, C.outEdge);
  label("ppl-stuck-label", SRC.stuck, C.stuckInk, { "text-size": 12.5 });
  map.setLayerZoomRange("ppl-homes-label", 11.5, 24);

  // Popups for the people marks.
  const popup = new Popup({ closeButton: false, maxWidth: "280px", className: "lc-popup" });
  const onClick = (e: MapLayerMouseEvent) => {
    const f = e.features?.[0];
    if (!f) return;
    popup.setLngLat(e.lngLat).setHTML(escapeHtml(String(f.properties.label ?? ""))).addTo(map);
  };
  const enter = () => (map.getCanvas().style.cursor = "pointer");
  const leave = () => (map.getCanvas().style.cursor = "");
  for (const id of PEOPLE_INTERACTIVE_LAYERS) {
    map.on("click", id, onClick);
    map.on("mouseenter", id, enter);
    map.on("mouseleave", id, leave);
  }

  // State held between polls; the animation reads it every frame.
  let moving: MovingEdge[] = [];
  let staticDots: Feature[] = [];
  let running = false;
  let visible = true;
  let simT = 0;
  let lastWall = performance.now();
  let lastFrame = 0;
  let frame = 0;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const drawDots = () => {
    const feats = staticDots.slice();
    for (const m of moving) {
      const shift = m.g.len > 0 ? (simT * m.speedMs * MOTION_SCALE) / m.g.len : 0;
      for (let k = 0; k < m.n; k++) {
        const f = (m.phase + k / m.n + shift) % 1;
        feats.push(pt(along(m.g, f), { s: DOT_STATE.driving }));
      }
    }
    (map.getSource(SRC.dots) as GeoJSONSource | undefined)?.setData(fc(feats));
  };

  const tick = (now: number) => {
    frame = requestAnimationFrame(tick);
    const dt = (now - lastWall) / 1000;
    lastWall = now;
    if (running) simT += Math.min(dt, 0.5);
    if (!visible || !moving.length || !running || now - lastFrame < FRAME_MS) return;
    lastFrame = now;
    drawDots();
  };
  if (!reduced) frame = requestAnimationFrame(tick);

  const set = (id: string, data: GeoJSON.FeatureCollection) => (map.getSource(id) as GeoJSONSource | undefined)?.setData(data);

  return {
    update(snapshot) {
      if (!snapshot) {
        moving = [];
        staticDots = [];
        for (const id of Object.values(SRC)) set(id, fc([]));
        return;
      }
      running = snapshot.drill_speed > 0;
      const ppd = peoplePerDot(snapshot);
      const fields = snapshot.edges.fields;
      const I = {
        edge: col(fields, "edge_index", 0),
        moving: col(fields, "moving", 1),
        queued: col(fields, "queued", 2),
        stuck: col(fields, "stuck", 3),
        reason: col(fields, "reason", 4),
        speed: col(fields, "speed_kph", 6),
        wait: col(fields, "max_wait_min", 7),
        line: col(fields, "line", 10),
      };
      const nextMoving: MovingEdge[] = [];
      const dots: Feature[] = [];
      const roads: Feature[] = [];
      for (const row of snapshot.edges.rows as PeopleEdgeRow[]) {
        const line = row[I.line] as LonLat[];
        if (!Array.isArray(line) || line.length < 2) continue;
        const g = edgeGeom(line);
        const edge = row[I.edge] as number;
        const mov = row[I.moving] as number;
        const que = row[I.queued] as number;
        const stk = row[I.stuck] as number;
        const reason = row[I.reason] as string | null;
        const speed = row[I.speed] as number;
        if (mov > 0) {
          nextMoving.push({
            g,
            n: Math.max(1, Math.round(mov / ppd)),
            speedMs: Math.max(MIN_SPEED_MS, speed / 3.6),
            phase: phaseOf(edge),
          });
        }
        if (stk > 0) {
          packed(g, Math.max(1, Math.round(stk / ppd)), DOT_STATE.stuck, dots);
          roads.push({
            type: "Feature",
            geometry: { type: "LineString", coordinates: line },
            properties: {
              state: "stuck",
              people: stk,
              label: `Simulated: ${nf(stk)} stuck here, ${REASON_SHORT[reason ?? "long_queue"] ?? "stuck"}` +
                `${row[I.wait] ? `; longest wait ${nf(row[I.wait] as number)} min` : ""}`,
            },
          });
        }
        if (que > 0) {
          packed(g, Math.max(1, Math.round(que / ppd)), DOT_STATE.queued, dots);
          if (!stk) {
            roads.push({
              type: "Feature",
              geometry: { type: "LineString", coordinates: line },
              properties: {
                state: "queued",
                people: que,
                label: `Simulated: ${nf(que)} waiting in traffic here, ${Math.round(speed)} km/h`,
              },
            });
          }
        }
      }
      moving = nextMoving;
      staticDots = dots;

      set(
        SRC.homes,
        fc(
          snapshot.zones
            .filter((z) => z.home + z.home_no_car + z.staying > 0)
            .map((z) => {
              const n = z.home + z.home_no_car + z.staying;
              const parts = [`${nf(z.home)} have not left yet`];
              if (z.home_no_car) parts.push(`${nf(z.home_no_car)} without a car`);
              if (z.staying) parts.push(`${nf(z.staying)} staying put`);
              return pt(z.coord, {
                people: n,
                text: `${nf(n)} home`,
                label: `Simulated: ${nf(n)} of ${nf(z.population)} residents still home (${parts.join(", ")})`,
              });
            }),
        ),
      );
      set(SRC.roads, fc(roads));
      set(
        SRC.points,
        fc(
          snapshot.points.map((p) =>
            pt(p.coord, { people: p.people, state: p.state, label: `Simulated: ${nf(p.people)} ${p.text}` }),
          ),
        ),
      );
      set(
        SRC.out,
        fc(
          snapshot.destinations
            .filter((d) => d.people > 0)
            .map((d) =>
              pt(d.coord, {
                people: d.people,
                text: `${nf(d.people)} out via ${d.name}`,
                label: `Simulated: ${nf(d.people)} people reached ${d.name}; ${nf(d.last_10_min_people)} in the last 10 min`,
              }),
            ),
        ),
      );
      set(
        SRC.stuck,
        fc(
          snapshot.stuck.map((c) =>
            pt(c.coord, {
              people: c.people,
              text: `${nf(c.people)} stuck${c.road ? ` on ${c.road}` : ""}\n${c.reason_text}`,
              label: `Simulated: ${c.label}${c.longest_wait_min ? `; longest wait ${nf(c.longest_wait_min)} min` : ""}`,
            }),
          ),
        ),
      );
      drawDots();
    },
    setVisible(v) {
      visible = v;
      for (const id of PEOPLE_LAYER_IDS) {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", v ? "visible" : "none");
      }
      if (!v) popup.remove();
    },
    dispose() {
      cancelAnimationFrame(frame);
      popup.remove();
      for (const id of PEOPLE_INTERACTIVE_LAYERS) {
        map.off("click", id, onClick);
        map.off("mouseenter", id, enter);
        map.off("mouseleave", id, leave);
      }
      try {
        for (const id of PEOPLE_LAYER_IDS) if (map.getLayer(id)) map.removeLayer(id);
        for (const id of Object.values(SRC)) if (map.getSource(id)) map.removeSource(id);
      } catch {
        // The map is already being removed; its layers go with it.
      }
    },
  };
}
