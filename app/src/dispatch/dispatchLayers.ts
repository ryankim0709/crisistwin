import {
  Marker,
  type GeoJSONSource,
  type Map as MapLibreMap,
  type MapLayerMouseEvent,
} from "maplibre-gl";
import type { Feature, FeatureCollection, LineString, Point, Polygon } from "geojson";
import type { DispatchArea, LonLat } from "./area";
import {
  ROUTE_LOOKAHEAD_MINUTES,
  type DispatchEngine,
  type UnitState,
  type ZoneState,
} from "./engine";
import "./dispatchMap.css";

const PREFIX = "dispatch-";
const ZONES = `${PREFIX}zones`;
const BURNED = `${PREFIX}burned`;
const CLOSED = `${PREFIX}closed`;
const ROUTES = `${PREFIX}routes`;
const UNIT_PATHS = `${PREFIX}unit-paths`;
const VEHICLES = `${PREFIX}vehicles`;
const SOURCES = [ZONES, BURNED, CLOSED, ROUTES, UNIT_PATHS, VEHICLES];

const LAYER_ZONE_FILL = `${PREFIX}zone-fill`;
const LAYER_ZONE_FIRE = `${PREFIX}zone-fire`;
const LAYER_ZONE_SOLID = `${PREFIX}zone-outline`;
const LAYER_ZONE_DASHED = `${PREFIX}zone-outline-ordered`;
const LAYER_ZONE_BLOCKED = `${PREFIX}zone-blocked`;
const LAYER_ZONE_SELECTED = `${PREFIX}zone-selected`;
const LAYER_BURNED = `${PREFIX}burned-line`;
const LAYER_CLOSED = `${PREFIX}closed-line`;
const LAYER_ROUTE_CASING = `${PREFIX}route-casing`;
const LAYER_ROUTE = `${PREFIX}route-line`;
const LAYER_UNIT_PATHS = `${PREFIX}unit-path-line`;
const LAYER_VEHICLES = `${PREFIX}vehicle-circles`;
/** Bottom to top. */
const LAYERS = [
  LAYER_ZONE_FILL,
  LAYER_ZONE_FIRE,
  LAYER_ZONE_SOLID,
  LAYER_ZONE_DASHED,
  LAYER_ZONE_BLOCKED,
  LAYER_ZONE_SELECTED,
  LAYER_BURNED,
  LAYER_CLOSED,
  LAYER_ROUTE_CASING,
  LAYER_ROUTE,
  LAYER_UNIT_PATHS,
  LAYER_VEHICLES,
];

/** Map paint colours. MapLibre cannot read CSS variables, so these mirror the hazard tokens in
 * ui/tokens.css (`--ct-route`, `--ct-closure`, `--ct-shelter`, ...); the legend reads them too. */
export const COLORS = {
  neutral: "#ffffff",
  ordered: "#f2a33a", // --ct-ember
  cleared: "#22c55e", // --ct-shelter
  overrun: "#7f1d1d",
  overrunLine: "#dc2626", // --ct-closure
  blocked: "#dc2626", // --ct-closure
  fire: "#ee6b4d", // --ct-fire
  selected: "#38bdf8",
  burned: "#dc2626", // --ct-closure
  closed: "#ff6a1a", // --ct-fire-hot
  routeCasing: "#ffffff",
  route: "#3b82c4", // --ct-route
  unitPath: "#c7a6ff", // --ct-responder
  vehicle: "#5eead4", // --ct-evacuee
  vehicleStuck: "#d946ef",
  vehicleStroke: "#1f2937",
} as const;

const FILL_OPACITY = { no_order: 0.04, ordered: 0.3, cleared: 0.25, overrun: 0.55 } as const;
const OUTLINE_WIDTH = { thin: 1.2, normal: 2.4, thick: 3.6 } as const;
const VEHICLE_RADIUS_MIN = 2;
const VEHICLE_RADIUS_MAX = 8;
const ROUTE_CASING_WIDTH = 6;
const ROUTE_WIDTH = 3;
const SELECTED_Z_INDEX = "5";

type Props = Record<string, string | number | boolean>;
type Lines = FeatureCollection<LineString, Props>;
const EMPTY_LINES: Lines = { type: "FeatureCollection", features: [] };
const EMPTY_POINTS: FeatureCollection<Point, Props> = { type: "FeatureCollection", features: [] };

function line(coords: LonLat[], properties: Props = {}): Feature<LineString, Props> {
  return { type: "Feature", properties, geometry: { type: "LineString", coordinates: coords } };
}

function marker(
  className: string,
  text: string,
  position: LonLat,
  map: MapLibreMap,
  title?: string,
) {
  const element = document.createElement("div");
  element.className = className;
  element.textContent = text;
  if (title) element.title = title;
  return new Marker({ element, anchor: "center" }).setLngLat(position).addTo(map);
}

function zoneLabel(
  zone: ZoneState | undefined,
  id: string,
): { text: string; show: boolean; status: string } {
  if (!zone) return { text: id, show: false, status: "no_order" };
  let word = "";
  if (zone.routeBlocked) word = "BLOCKED";
  else if (zone.status === "ordered") word = `ORDERED → ${zone.exitId ?? "?"}`;
  else if (zone.status === "cleared") word = "CLEAR";
  else if (zone.status === "overrun") word = "OVERRUN";
  else if (zone.fireContact) word = "FIRE";
  const show = zone.status !== "no_order" || zone.fireContact;
  return { text: word ? `${id} ${word}` : id, show, status: zone.status };
}

export class DispatchLayers {
  private zoneMarkers = new Map<string, Marker>();
  private unitMarkers = new Map<string, Marker>();
  private staticMarkers: Marker[] = [];
  private selected: string | null = null;
  private destroyed = false;
  private readonly onClick: (event: MapLayerMouseEvent) => void;
  private readonly onEnter = () => {
    this.map.getCanvas().style.cursor = "pointer";
  };
  private readonly onLeave = () => {
    this.map.getCanvas().style.cursor = "";
  };

  constructor(
    private readonly map: MapLibreMap,
    private readonly area: DispatchArea,
    options: { onSelectZone?: (zoneId: string) => void },
  ) {
    this.onClick = (event) => {
      const id = event.features?.[0]?.properties?.id;
      if (typeof id === "string") options.onSelectZone?.(id);
    };
    this.addSources();
    this.addLayers();
    map.on("click", LAYER_ZONE_FILL, this.onClick);
    map.on("mouseenter", LAYER_ZONE_FILL, this.onEnter);
    map.on("mouseleave", LAYER_ZONE_FILL, this.onLeave);
    this.addStaticMarkers();
    for (const zone of area.zones) {
      const m = marker("dsp-zone-label", zone.id, zone.centroid, map);
      m.getElement().addEventListener("click", (event) => {
        event.stopPropagation();
        options.onSelectZone?.(zone.id);
      });
      m.getElement().style.display = "none";
      this.zoneMarkers.set(zone.id, m);
    }
    this.update(null);
  }

  update(engine: DispatchEngine | null): void {
    if (this.destroyed) return;
    this.setData(ZONES, this.zoneCollection(engine));
    this.updateZoneLabels(engine);
    this.updateRoads(engine);
    this.setData(
      ROUTES,
      engine
        ? {
            type: "FeatureCollection",
            features: engine.activeRoutes().map((r) => line(r.coords, { zone: r.zone })),
          }
        : EMPTY_LINES,
    );
    this.setData(
      VEHICLES,
      engine
        ? {
            type: "FeatureCollection",
            features: engine.vehiclePositions().map((v) => ({
              type: "Feature",
              properties: { vehicles: v.vehicles, stuck: v.stuck },
              geometry: { type: "Point", coordinates: v.position },
            })),
          }
        : EMPTY_POINTS,
    );
    this.updateUnits(engine);
  }

  setSelectedZone(zoneId: string | null): void {
    if (this.destroyed) return;
    this.selected = zoneId;
    try {
      this.map.setFilter(LAYER_ZONE_SELECTED, ["==", ["get", "id"], zoneId ?? ""]);
    } catch {
      /* map already gone */
    }
    for (const [id, m] of this.zoneMarkers) {
      const element = m.getElement();
      element.classList.toggle("dsp-zone-label--selected", id === zoneId);
      element.style.zIndex = id === zoneId ? SELECTED_Z_INDEX : "";
      if (id === zoneId) element.style.display = "";
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const m of [
      ...this.zoneMarkers.values(),
      ...this.unitMarkers.values(),
      ...this.staticMarkers,
    ])
      m.remove();
    this.zoneMarkers.clear();
    this.unitMarkers.clear();
    this.staticMarkers = [];
    try {
      this.map.off("click", LAYER_ZONE_FILL, this.onClick);
      this.map.off("mouseenter", LAYER_ZONE_FILL, this.onEnter);
      this.map.off("mouseleave", LAYER_ZONE_FILL, this.onLeave);
      this.map.getCanvas().style.cursor = "";
      for (const id of [...LAYERS].reverse()) if (this.map.getLayer(id)) this.map.removeLayer(id);
      for (const id of SOURCES) if (this.map.getSource(id)) this.map.removeSource(id);
    } catch {
      /* map already removed */
    }
  }

  // ---- setup -------------------------------------------------------------------------

  private addSources() {
    this.map.addSource(ZONES, { type: "geojson", data: this.zoneCollection(null) });
    for (const id of [BURNED, CLOSED, ROUTES, UNIT_PATHS])
      this.map.addSource(id, { type: "geojson", data: EMPTY_LINES });
    this.map.addSource(VEHICLES, { type: "geojson", data: EMPTY_POINTS });
  }

  private addLayers() {
    const map = this.map;
    const byStatus = (none: unknown, ordered: unknown, cleared: unknown, overrun: unknown) =>
      [
        "match",
        ["get", "status"],
        "ordered",
        ordered,
        "cleared",
        cleared,
        "overrun",
        overrun,
        none,
      ] as never;
    map.addLayer({
      id: LAYER_ZONE_FILL,
      type: "fill",
      source: ZONES,
      paint: {
        "fill-color": byStatus(COLORS.neutral, COLORS.ordered, COLORS.cleared, COLORS.overrun),
        "fill-opacity": byStatus(
          FILL_OPACITY.no_order,
          FILL_OPACITY.ordered,
          FILL_OPACITY.cleared,
          FILL_OPACITY.overrun,
        ),
      },
    });
    // Fire contact: a wide soft orange halo under the outline.
    map.addLayer({
      id: LAYER_ZONE_FIRE,
      type: "line",
      source: ZONES,
      filter: ["==", ["get", "fire"], true],
      paint: { "line-color": COLORS.fire, "line-width": 8, "line-opacity": 0.45, "line-blur": 2 },
    });
    map.addLayer({
      id: LAYER_ZONE_SOLID,
      type: "line",
      source: ZONES,
      filter: ["!=", ["get", "status"], "ordered"],
      paint: {
        "line-color": byStatus(COLORS.neutral, COLORS.ordered, COLORS.cleared, COLORS.overrunLine),
        "line-width": byStatus(
          OUTLINE_WIDTH.thin,
          OUTLINE_WIDTH.normal,
          OUTLINE_WIDTH.normal,
          OUTLINE_WIDTH.thick,
        ),
        "line-opacity": byStatus(0.55, 1, 1, 1),
      },
    });
    map.addLayer({
      id: LAYER_ZONE_DASHED,
      type: "line",
      source: ZONES,
      filter: ["==", ["get", "status"], "ordered"],
      paint: {
        "line-color": COLORS.ordered,
        "line-width": OUTLINE_WIDTH.normal,
        "line-dasharray": [3, 2],
      },
    });
    map.addLayer({
      id: LAYER_ZONE_BLOCKED,
      type: "line",
      source: ZONES,
      filter: ["==", ["get", "blocked"], true],
      paint: {
        "line-color": COLORS.blocked,
        "line-width": OUTLINE_WIDTH.thick,
        "line-dasharray": [1.5, 1.5],
      },
    });
    map.addLayer({
      id: LAYER_ZONE_SELECTED,
      type: "line",
      source: ZONES,
      filter: ["==", ["get", "id"], ""],
      paint: { "line-color": COLORS.selected, "line-width": 4.5 },
    });
    map.addLayer({
      id: LAYER_BURNED,
      type: "line",
      source: BURNED,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": COLORS.burned, "line-width": 3.5 },
    });
    map.addLayer({
      id: LAYER_CLOSED,
      type: "line",
      source: CLOSED,
      layout: { "line-join": "round" },
      paint: { "line-color": COLORS.closed, "line-width": 3, "line-dasharray": [2, 1.5] },
    });
    map.addLayer({
      id: LAYER_ROUTE_CASING,
      type: "line",
      source: ROUTES,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": COLORS.routeCasing,
        "line-width": ROUTE_CASING_WIDTH,
        "line-opacity": 0.9,
      },
    });
    map.addLayer({
      id: LAYER_ROUTE,
      type: "line",
      source: ROUTES,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": COLORS.route, "line-width": ROUTE_WIDTH },
    });
    map.addLayer({
      id: LAYER_UNIT_PATHS,
      type: "line",
      source: UNIT_PATHS,
      paint: { "line-color": COLORS.unitPath, "line-width": 2.5, "line-dasharray": [2, 2] },
    });
    map.addLayer({
      id: LAYER_VEHICLES,
      type: "circle",
      source: VEHICLES,
      paint: {
        "circle-radius": [
          "max",
          VEHICLE_RADIUS_MIN,
          ["min", VEHICLE_RADIUS_MAX, ["sqrt", ["get", "vehicles"]]],
        ] as never,
        "circle-color": ["case", ["get", "stuck"], COLORS.vehicleStuck, COLORS.vehicle] as never,
        "circle-stroke-color": COLORS.vehicleStroke,
        "circle-stroke-width": 1.5,
      },
    });
  }

  private addStaticMarkers() {
    for (const exit of this.area.exits) {
      const position = this.area.nodes[exit.node];
      this.staticMarkers.push(
        marker("dsp-exit", `⇥ ${exit.id}`, position, this.map, `${exit.name} (${exit.road})`),
      );
    }
    for (const station of this.area.stations) {
      this.staticMarkers.push(
        marker("dsp-station", `▲ ${station.id}`, station.location, this.map, station.name),
      );
    }
  }

  // ---- updates -----------------------------------------------------------------------

  private setData(sourceId: string, data: FeatureCollection) {
    const source = this.map.getSource<GeoJSONSource>(sourceId);
    if (!source) return;
    void Promise.resolve(source.setData(data)).catch(() => undefined);
  }

  private zoneCollection(engine: DispatchEngine | null): FeatureCollection<Polygon, Props> {
    return {
      type: "FeatureCollection",
      features: this.area.zones.map((zone, index) => {
        const state = engine?.zones[index];
        return {
          type: "Feature",
          properties: {
            id: zone.id,
            status: state?.status ?? "no_order",
            blocked: Boolean(state?.routeBlocked),
            fire: Boolean(state && state.fireContact && state.status !== "cleared"),
          },
          geometry: { type: "Polygon", coordinates: [zone.polygon] },
        };
      }),
    };
  }

  private updateZoneLabels(engine: DispatchEngine | null) {
    this.area.zones.forEach((zone, index) => {
      const m = this.zoneMarkers.get(zone.id);
      if (!m) return;
      const info = zoneLabel(engine?.zones[index], zone.id);
      const element = m.getElement();
      element.textContent = info.text;
      element.dataset.status = info.status;
      element.style.display = info.show || zone.id === this.selected ? "" : "none";
    });
  }

  private updateRoads(engine: DispatchEngine | null) {
    if (!engine) {
      this.setData(BURNED, EMPTY_LINES);
      this.setData(CLOSED, EMPTY_LINES);
      return;
    }
    const arrival = engine.exposure.edgeArrival;
    const minute = engine.minute;
    const burned: Feature<LineString, Props>[] = [];
    const closed: Feature<LineString, Props>[] = [];
    for (const edge of this.area.edges) {
      const t = arrival[edge.index];
      if (t <= minute) burned.push(line(edge.coords));
      else if (t <= minute + ROUTE_LOOKAHEAD_MINUTES) closed.push(line(edge.coords));
    }
    this.setData(BURNED, { type: "FeatureCollection", features: burned });
    this.setData(CLOSED, { type: "FeatureCollection", features: closed });
  }

  private updateUnits(engine: DispatchEngine | null) {
    const paths: Feature<LineString, Props>[] = [];
    const seen = new Set<string>();
    if (engine) {
      const stationNode = new Map(this.area.stations.map((s) => [s.id, s.node]));
      for (const unit of engine.units) {
        const idle = unit.status === "available" && unit.node === stationNode.get(unit.stationId);
        if (idle) continue;
        seen.add(unit.id);
        this.placeUnit(engine, unit);
        const path = engine.unitPath(unit);
        if (path.length > 1) paths.push(line(path, { unit: unit.id }));
      }
    }
    for (const [id, m] of this.unitMarkers) {
      if (!seen.has(id)) {
        m.remove();
        this.unitMarkers.delete(id);
      }
    }
    this.setData(UNIT_PATHS, { type: "FeatureCollection", features: paths });
  }

  private placeUnit(engine: DispatchEngine, unit: UnitState) {
    const position = engine.unitPosition(unit);
    let m = this.unitMarkers.get(unit.id);
    if (m) m.setLngLat(position);
    else {
      m = marker("dsp-unit", unit.id, position, this.map);
      this.unitMarkers.set(unit.id, m);
    }
    const element = m.getElement();
    element.dataset.status = unit.status;
    const zone = unit.zone === null ? null : this.area.zones[unit.zone]?.id;
    element.title = `${unit.id}: ${unit.status.replace("_", " ")}${unit.task ? `, ${unit.task.replace("_", " ")}` : ""}${zone ? `, ${zone}` : ""}`;
    element.textContent = `${unit.status === "stranded" ? "! " : ""}${unit.id}`;
  }
}
