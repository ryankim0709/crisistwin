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
  chevrons: "ppl-chevrons",
  roads: "ppl-roads",
  dots: "ppl-dots",
  points: "ppl-points",
  out: "ppl-out",
  stuck: "ppl-stuck",
} as const;

export const PEOPLE_LAYER_IDS = [
  "ppl-density",
  "ppl-homes",
  "ppl-homes-label",
  "ppl-roads-casing",
  "ppl-roads",
  "ppl-chevrons",
  "ppl-points",
  "ppl-dots",
  "ppl-out",
  "ppl-out-label",
  "ppl-out-label-all",
  "ppl-stuck",
  "ppl-stuck-label",
  "ppl-stuck-label-all",
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

/** Rotation (deg clockwise, for a ">" glyph that points east) of the line direction at fraction f. */
function rotationAt(g: EdgeGeom, f: number): number {
  const a = along(g, f - 0.01);
  const b = along(g, f + 0.01);
  const kx = Math.cos((a[1] * Math.PI) / 180);
  const bearing = (Math.atan2((b[0] - a[0]) * kx, b[1] - a[1]) * 180) / Math.PI;
  return bearing - 90;
}

interface FlowEdge {
  g: EdgeGeom;
  /** Chevrons along the edge. */
  n: number;
  /** Fraction of the edge per second the chevrons advance (0 for slow or stuck roads). */
  rate: number;
  phase: number;
}

const MAX_CHEVRONS = 1800;

/** Clock time like "2:40 pm" in the incident's time zone. */
function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }).toLowerCase();
}

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
  /** Line width grows with the square root of people on the road (people, px). */
  const WIDTH = (min: number, mid: number, max: number, _z: number) =>
    ["interpolate", ["linear"], ["sqrt", ["get", "people"]], 1, min, 20, mid, 60, max] as never;
  const byPeople = (min: number, max: number) =>
    ["interpolate", ["linear"], ["sqrt", ["get", "people"]], 1, min, 30, (min + max) / 2, 80, max] as never;

  // Smooth density surface of people still home; weight = share of the busiest zone, so it fades as they leave.
  add({
    id: "ppl-density",
    type: "heatmap",
    source: SRC.homes,
    paint: {
      "heatmap-weight": ["get", "w"] as never,
      "heatmap-intensity": 1,
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 8, 30, 11, 60, 13, 100, 16, 180] as never,
      "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0.85, 16, 0.45] as never,
      "heatmap-color": [
        "interpolate", ["linear"], ["heatmap-density"],
        0, "rgba(99,102,241,0)", 0.1, "rgba(165,180,252,0.30)", 0.35, "rgba(129,140,248,0.55)",
        0.65, "rgba(79,70,229,0.75)", 1, "rgba(49,46,129,0.9)",
      ] as never,
    },
  });
  add({
    id: "ppl-homes",
    type: "circle",
    source: SRC.homes,
    minzoom: 12.5,
    paint: {
      "circle-radius": byPeople(3, 16),
      "circle-color": C.home,
      "circle-opacity": 0.2,
      "circle-stroke-color": C.homeEdge,
      "circle-stroke-width": 1,
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
      "line-width": WIDTH(2, 7, 22, 3),
    },
  });
  add({
    id: "ppl-roads",
    type: "line",
    source: SRC.roads,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["match", ["get", "state"], "stuck", C.stuck, "queued", C.flowSlow, C.flowMoving] as never,
      "line-opacity": 0.92,
      "line-width": WIDTH(1, 4.5, 18, 0),
    },
  });
  add({
    id: "ppl-chevrons",
    type: "symbol",
    source: SRC.chevrons,
    layout: {
      "text-field": ">",
      "text-font": ["Noto Sans Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 9, 9, 14, 14] as never,
      "text-rotate": ["get", "rot"],
      "text-rotation-alignment": "map",
      "text-pitch-alignment": "map",
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    } as never,
    paint: { "text-color": "#FFFFFF", "text-halo-color": "rgba(15,23,32,0.55)", "text-halo-width": 0.8 },
  });
  add({
    id: "ppl-points",
    type: "circle",
    source: SRC.points,
    minzoom: 13.5,
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
    minzoom: 13.5,
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
  // Regional zoom: only the top 3 stuck groups and top 3 exits are named; closer in, all of them.
  const top3 = ["<=", ["get", "rank"], 3] as never;
  label("ppl-out-label", SRC.out, C.outEdge);
  label("ppl-stuck-label", SRC.stuck, C.stuckInk, { "text-size": 12.5 });
  for (const id of ["ppl-out-label", "ppl-stuck-label"]) {
    map.setFilter(id, top3);
    const src = id === "ppl-out-label" ? SRC.out : SRC.stuck;
    label(`${id}-all`, src, id === "ppl-out-label" ? C.outEdge : C.stuckInk, { "text-size": 12 });
    map.setLayerZoomRange(id, 0, 13);
    map.setLayerZoomRange(`${id}-all`, 13, 24);
  }
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

  // On-map time readout and legend (DOM, so they follow the playback clock and read at a glance).
  const host = map.getContainer();
  const readout = document.createElement("div");
  readout.className = "ppl-readout";
  readout.setAttribute("aria-live", "polite");
  readout.hidden = true;
  const legend = document.createElement("div");
  legend.className = "ppl-legend";
  legend.hidden = true;
  legend.innerHTML =
    `<div class="ppl-legend-row"><i class="ppl-lg-heat"></i>People still home (darker = more)</div>` +
    `<div class="ppl-legend-row"><i class="ppl-lg-line" style="background:${C.flowMoving}"></i>Moving` +
    `<i class="ppl-lg-line" style="background:${C.flowSlow}"></i>Slow` +
    `<i class="ppl-lg-line" style="background:${C.stuck}"></i>Stuck</div>` +
    `<div class="ppl-legend-row"><span class="ppl-lg-widths"><i style="height:2px"></i><i style="height:5px"></i><i style="height:10px"></i></span>` +
    `Thicker road = more people</div>`;
  host.append(readout, legend);

  // State held between polls; the animation reads it every frame.
  let moving: MovingEdge[] = [];
  let flow: FlowEdge[] = [];
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

  const drawChevrons = () => {
    const feats: Feature[] = [];
    for (const e of flow) {
      for (let k = 0; k < e.n; k++) {
        const f = (e.phase + k / e.n + simT * e.rate) % 1;
        feats.push(pt(along(e.g, f), { rot: Math.round(rotationAt(e.g, f)) }));
      }
    }
    (map.getSource(SRC.chevrons) as GeoJSONSource | undefined)?.setData(fc(feats));
  };

  const tick = (now: number) => {
    frame = requestAnimationFrame(tick);
    const dt = (now - lastWall) / 1000;
    lastWall = now;
    if (running) simT += Math.min(dt, 0.5);
    if (!visible || !moving.length || !running || now - lastFrame < FRAME_MS) return;
    lastFrame = now;
    drawDots();
    drawChevrons();
  };
  if (!reduced) frame = requestAnimationFrame(tick);

  const set = (id: string, data: GeoJSON.FeatureCollection) => (map.getSource(id) as GeoJSONSource | undefined)?.setData(data);

  return {
    update(snapshot) {
      if (!snapshot) {
        moving = [];
        flow = [];
        staticDots = [];
        readout.hidden = true;
        legend.hidden = true;
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
      const nextFlow: FlowEdge[] = [];
      let chevCount = 0;
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
        if (stk > 0) packed(g, Math.max(1, Math.round(stk / ppd)), DOT_STATE.stuck, dots);
        if (que > 0) packed(g, Math.max(1, Math.round(que / ppd)), DOT_STATE.queued, dots);
        const total = mov + que + stk;
        if (total <= 0) continue;
        const freeFlow = row[8] as number;
        const slow = que > 0 || (freeFlow > 0 && speed < freeFlow * 0.5);
        const state = stk > 0 ? "stuck" : slow ? "queued" : "moving";
        const where = [
          mov ? `${nf(mov)} moving at ${Math.round(speed)} km/h` : "",
          que ? `${nf(que)} waiting in traffic` : "",
          stk ? `${nf(stk)} stuck, ${REASON_SHORT[reason ?? "long_queue"] ?? "stuck"}${row[I.wait] ? `; longest wait ${nf(row[I.wait] as number)} min` : ""}` : "",
        ].filter(Boolean);
        roads.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: line },
          properties: { state, people: total, label: `Simulated: ${where.join("; ")} on this road` },
        });
        const n = Math.min(12, Math.max(1, Math.floor(g.len / 160)));
        if (chevCount + n <= MAX_CHEVRONS) {
          chevCount += n;
          nextFlow.push({
            g,
            n,
            // Display speed of the flow, capped so fast roads do not blur; slow and stuck roads barely creep.
            rate: state === "moving" && g.len > 0 ? Math.min(0.08, (Math.max(MIN_SPEED_MS, speed / 3.6) * MOTION_SCALE * 0.25) / g.len) : 0,
            phase: phaseOf(edge),
          });
        }
      }
      moving = nextMoving;
      flow = nextFlow;
      staticDots = dots;

      const maxHome = Math.max(1, ...snapshot.zones.map((z) => z.home + z.home_no_car + z.staying));
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
                w: n / maxHome,
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
            .sort((a, b) => b.people - a.people)
            .map((d, i) =>
              pt(d.coord, {
                rank: i + 1,
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
          [...snapshot.stuck]
            .sort((a, b) => b.people - a.people)
            .map((c, i) =>
            pt(c.coord, {
              rank: i + 1,
              people: c.people,
              text: `${nf(c.people)} stuck${c.road ? ` on ${c.road}` : ""}\n${c.reason_text}`,
              label: `Simulated: ${c.label}${c.longest_wait_min ? `; longest wait ${nf(c.longest_wait_min)} min` : ""}`,
            }),
          ),
        ),
      );
      drawDots();
      drawChevrons();
      const t = snapshot.totals.people;
      const at = clock(snapshot.drill_replay_now);
      readout.textContent =
        `${at ? `At ${at}: ` : ""}${nf(t.home + t.home_no_car + t.staying)} home · ${nf(t.driving + t.queued)} on the road · ` +
        `${nf(t.stuck)} stuck · ${nf(t.out)} out`;
      readout.hidden = !visible;
      legend.hidden = !visible;
    },
    setVisible(v) {
      visible = v;
      readout.hidden = !v || !readout.textContent;
      legend.hidden = readout.hidden;
      for (const id of PEOPLE_LAYER_IDS) {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", v ? "visible" : "none");
      }
      if (!v) popup.remove();
    },
    dispose() {
      cancelAnimationFrame(frame);
      readout.remove();
      legend.remove();
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
