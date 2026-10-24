"""Build the dispatch-agent area fixture: OSM roads, fire stations and synthetic demand zones.

The /dispatch page (docs/adr/0014-dispatch-agent.md) needs a drivable road graph, evacuation
zones with vehicle counts, exits and fire stations around the Simulation Studio demo fires
(Oakland/Berkeley hills, downwind of a NE wind). This tool queries the OpenStreetMap Overpass
API once and writes a compact JSON the browser loads; nothing is fetched at runtime.

Observed (OSM): road geometry, class, name, lanes, maxspeed, oneway; fire station locations.
Assumed (named constants below): lane capacity and default speed by class, homes per km of
residential street, vehicles per home, one engine per station. Zones are grid cells over
residential streets, not official evacuation zones; their names are the nearest OSM place.

Run from the repository root (needs internet; stdlib only):
  python3 -m tools.build_dispatch_area --output app/public/dispatch/east-bay-hills.json
"""

from __future__ import annotations

import argparse
import json
import math
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
USER_AGENT = "CrisisTwin/0.1 (hackathon research; github.com/ryankim0709/crisistwin)"

AREA_ID = "east-bay-hills"
AREA_NAME = "Oakland / Berkeley hills"
# south, west, north, east (Overpass order). Covers the Studio demo fires (around 37.87,
# -122.20) and the hill neighbourhoods downwind of a NE wind.
BBOX = (37.82, -122.26, 37.905, -122.15)

ROAD_CLASSES = (
    "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
    "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified",
    "residential", "living_street",
)
EXIT_CLASSES = {"motorway", "trunk", "primary", "secondary"}
RESIDENTIAL_CLASSES = {"residential", "living_street", "unclassified"}
PLACE_KINDS = ("neighbourhood", "suburb", "quarter", "hamlet", "village", "town")

# Assumed traffic parameters (not observed). Saturation flow per lane by class, vehicles/hour,
# lower than urban arterial textbook values to reflect narrow, curving hill roads.
CAPACITY_PER_LANE_VPH = {
    "motorway": 1900, "trunk": 1600, "primary": 1200, "secondary": 1000, "tertiary": 800,
}
DEFAULT_CAPACITY_PER_LANE_VPH = 600
SPEED_DEFAULT_KPH = {
    "motorway": 100, "trunk": 80, "primary": 56, "secondary": 48, "tertiary": 40,
    "unclassified": 40, "residential": 32, "living_street": 16,
}
KPH_PER_MPH = 1.609344

# Synthetic demand: homes per km of residential street (both sides) and evacuating vehicles
# per home. Planning placeholders, not Census counts.
HOMES_PER_KM = 50
VEHICLES_PER_HOME = 1.6
ZONE_CELL_METERS = 1200
MIN_ZONE_STREET_KM = 1.5
EXIT_DEDUPE_METERS = 400
ENGINES_PER_STATION = 1

EARTH_RADIUS_M = 6_371_008.8


def overpass(query: str) -> dict:
    body = urllib.parse.urlencode({"data": query}).encode()
    request = urllib.request.Request(OVERPASS_URL, data=body, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=240) as response:
        return json.load(response)


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


def inside(lon: float, lat: float) -> bool:
    s, w, n, e = BBOX
    return s <= lat <= n and w <= lon <= e


def parse_speed_kph(tag: str | None, cls: str) -> float:
    default = SPEED_DEFAULT_KPH.get(cls.removesuffix("_link"), 40)
    if not tag:
        return default
    text = tag.strip().lower()
    try:
        if text.endswith("mph"):
            return float(text[:-3].strip()) * KPH_PER_MPH
        return float(text)
    except ValueError:
        return default


def lanes_one_direction(tags: dict, oneway: bool) -> int:
    try:
        lanes = int(str(tags.get("lanes", "")).split(";")[0])
    except ValueError:
        lanes = 0
    if lanes <= 0:
        return 2 if tags["highway"] == "motorway" else 1
    return lanes if oneway else max(1, lanes // 2)


def convex_hull(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    pts = sorted(set(points))
    if len(pts) < 3:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def side_of_box(lon: float, lat: float) -> str:
    s, w, n, e = BBOX
    distances = {"south": lat - s, "north": n - lat, "west": lon - w, "east": e - lon}
    return min(distances, key=distances.get)


def build() -> dict:
    s, w, n, e = BBOX
    box = f"{s},{w},{n},{e}"
    classes = "|".join(ROAD_CLASSES)
    roads = overpass(f'[out:json][timeout:180];way[highway~"^({classes})$"]({box});out body;>;out skel qt;')
    places = overpass(
        f'[out:json][timeout:60];(node[place~"^({"|".join(PLACE_KINDS)})$"]({box});'
        f'nwr[amenity=fire_station]({box}););out center;'
    )
    osm_timestamp = roads.get("osm3s", {}).get("timestamp_osm_base")

    coords: dict[int, tuple[float, float]] = {}
    ways = []
    for element in roads["elements"]:
        if element["type"] == "node":
            coords[element["id"]] = (element["lon"], element["lat"])
        elif element["type"] == "way":
            ways.append(element)

    # Split each way into runs of consecutive inside nodes; remember boundary-crossing nodes
    # of major roads as exit candidates, with the direction a vehicle would leave.
    runs = []
    exit_candidates = []
    for way in ways:
        tags = way.get("tags", {})
        cls = tags["highway"]
        oneway = tags.get("oneway") in ("yes", "true", "1") or cls in ("motorway", "motorway_link")
        reverse = tags.get("oneway") == "-1"
        refs = list(reversed(way["nodes"])) if reverse else way["nodes"]
        oneway = oneway or reverse
        run: list[int] = []
        for i, ref in enumerate(refs):
            if ref not in coords:
                continue
            if inside(*coords[ref]):
                run.append(ref)
                if cls in EXIT_CLASSES:
                    nxt = refs[i + 1] if i + 1 < len(refs) else None
                    prv = refs[i - 1] if i > 0 else None
                    leaves_forward = nxt in coords and not inside(*coords[nxt])
                    leaves_backward = (not oneway) and prv in coords and not inside(*coords[prv])
                    if leaves_forward or leaves_backward:
                        exit_candidates.append((ref, cls, tags.get("ref") or tags.get("name") or cls))
            else:
                if len(run) >= 2:
                    runs.append((run, tags, cls, oneway))
                run = []
        if len(run) >= 2:
            runs.append((run, tags, cls, oneway))

    usage: dict[int, int] = defaultdict(int)
    for run, *_ in runs:
        for ref in run:
            usage[ref] += 1
        usage[run[0]] += 1
        usage[run[-1]] += 1
    forced = {ref for ref, *_ in exit_candidates}

    node_index: dict[int, int] = {}
    nodes: list[list[float]] = []

    def node_id(ref: int) -> int:
        if ref not in node_index:
            node_index[ref] = len(nodes)
            lon, lat = coords[ref]
            nodes.append([round(lon, 6), round(lat, 6)])
        return node_index[ref]

    class_list = list(ROAD_CLASSES)
    names: list[str] = []
    name_index: dict[str, int] = {}
    edges = []
    for run, tags, cls, oneway in runs:
        name = tags.get("name") or tags.get("ref") or ""
        if name and name not in name_index:
            name_index[name] = len(names)
            names.append(name)
        kph = round(parse_speed_kph(tags.get("maxspeed"), cls), 1)
        base = cls.removesuffix("_link")
        capacity = lanes_one_direction(tags, oneway) * CAPACITY_PER_LANE_VPH.get(base, DEFAULT_CAPACITY_PER_LANE_VPH)
        start = 0
        for i in range(1, len(run)):
            ref = run[i]
            if i == len(run) - 1 or usage[ref] > 1 or ref in forced:
                segment = run[start : i + 1]
                length = sum(haversine_m(coords[a], coords[b]) for a, b in zip(segment, segment[1:]))
                if length > 0:
                    geometry = [c for ref_ in segment[1:-1] for c in (round(coords[ref_][0], 6), round(coords[ref_][1], 6))]
                    edges.append([
                        node_id(segment[0]), node_id(segment[-1]), round(length, 1), class_list.index(cls),
                        kph, capacity, 1 if oneway else 0, name_index.get(name, -1), geometry,
                    ])
                start = i

    # Keep the largest weakly connected component.
    parent = list(range(len(nodes)))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for edge in edges:
        ra, rb = find(edge[0]), find(edge[1])
        if ra != rb:
            parent[ra] = rb
    sizes: dict[int, int] = defaultdict(int)
    for i in range(len(nodes)):
        sizes[find(i)] += 1
    main = max(sizes, key=sizes.get)
    keep = [i for i in range(len(nodes)) if find(i) == main]
    remap = {old: new for new, old in enumerate(keep)}
    nodes = [nodes[i] for i in keep]
    edges = [[remap[e[0]], remap[e[1]], *e[2:]] for e in edges if e[0] in remap and e[1] in remap]
    ref_to_node = {ref: remap[idx] for ref, idx in node_index.items() if idx in remap}

    # Exits: deduplicated boundary crossings of major roads, highest class first.
    rank = {c: i for i, c in enumerate(("motorway", "trunk", "primary", "secondary"))}
    exits = []
    for ref, cls, label in sorted(exit_candidates, key=lambda c: rank[c[1]]):
        if ref not in ref_to_node:
            continue
        node = ref_to_node[ref]
        point = tuple(nodes[node])
        if any(haversine_m(point, tuple(nodes[x["node"]])) < EXIT_DEDUPE_METERS for x in exits):
            continue
        exits.append({"node": node, "road": label, "side": side_of_box(*point)})
    exits.sort(key=lambda x: (x["side"], x["road"]))
    for i, item in enumerate(exits, start=1):
        item["id"] = f"X{i:02d}"
        item["name"] = f"{item['road']} ({item['side']})"

    # Zones: grid cells over residential street length.
    lat0 = (s + n) / 2
    m_per_deg_lat = math.pi * EARTH_RADIUS_M / 180
    m_per_deg_lon = m_per_deg_lat * math.cos(math.radians(lat0))
    cells: dict[tuple[int, int], dict] = defaultdict(lambda: {"km": 0.0, "points": [], "nodes": defaultdict(float)})
    for edge in edges:
        if class_list[edge[3]] not in RESIDENTIAL_CLASSES:
            continue
        a, b = nodes[edge[0]], nodes[edge[1]]
        mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        key = (int((mid[0] - w) * m_per_deg_lon // ZONE_CELL_METERS), int((mid[1] - s) * m_per_deg_lat // ZONE_CELL_METERS))
        cell = cells[key]
        cell["km"] += edge[2] / 1000
        cell["points"].extend([tuple(a), tuple(b)])
        cell["nodes"][edge[0]] += edge[2]
        cell["nodes"][edge[1]] += edge[2]

    place_points = []
    stations = []
    for element in places["elements"]:
        tags = element.get("tags", {})
        lat = element.get("lat", element.get("center", {}).get("lat"))
        lon = element.get("lon", element.get("center", {}).get("lon"))
        if lat is None or not inside(lon, lat):
            continue
        if tags.get("amenity") == "fire_station":
            stations.append({"name": tags.get("name") or "Fire station", "location": [round(lon, 6), round(lat, 6)]})
        elif tags.get("name"):
            place_points.append((tags["name"], (lon, lat)))

    zones = []
    for key in sorted(cells, key=lambda k: (-k[1], k[0])):
        cell = cells[key]
        if cell["km"] < MIN_ZONE_STREET_KM:
            continue
        hull = convex_hull(cell["points"])
        cx = sum(p[0] for p in hull) / len(hull)
        cy = sum(p[1] for p in hull) / len(hull)
        # Loading node: the best-connected residential node nearest the centroid.
        node = min(cell["nodes"], key=lambda i: haversine_m((cx, cy), tuple(nodes[i])) / (1 + cell["nodes"][i] / 1000))
        near = min(place_points, key=lambda p: haversine_m((cx, cy), p[1]))[0] if place_points else "area"
        homes = round(cell["km"] * HOMES_PER_KM)
        zones.append({
            "near": near, "node": node, "homes": homes, "vehicles": round(homes * VEHICLES_PER_HOME),
            "streetKm": round(cell["km"], 2), "centroid": [round(cx, 6), round(cy, 6)],
            "polygon": [[round(p[0], 6), round(p[1], 6)] for p in hull],
        })
    for i, zone in enumerate(zones, start=1):
        zone["id"] = f"Z{i:02d}"
        zone["name"] = f"Z{i:02d} · near {zone.pop('near')}"

    for i, station in enumerate(sorted(stations, key=lambda st: st["name"]), start=1):
        station["id"] = f"S{i:02d}"
        station["node"] = min(range(len(nodes)), key=lambda j: haversine_m(tuple(station["location"]), tuple(nodes[j])))
        station["units"] = [{"id": f"E{i:02d}{'' if k == 0 else chr(97 + k)}", "type": "engine"} for k in range(ENGINES_PER_STATION)]
    stations.sort(key=lambda st: st["id"])

    return {
        "kind": "crisistwin_dispatch_area",
        "schemaVersion": 1,
        "id": AREA_ID,
        "name": AREA_NAME,
        "bbox": [w, s, e, n],
        "generatedAt": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sources": {
            "osm": {
                "timestamp": osm_timestamp,
                "attribution": "Roads and fire stations © OpenStreetMap contributors, ODbL",
            }
        },
        "assumptions": {
            "homesPerKm": HOMES_PER_KM,
            "vehiclesPerHome": VEHICLES_PER_HOME,
            "zoneCellMeters": ZONE_CELL_METERS,
            "capacityPerLaneVph": {**CAPACITY_PER_LANE_VPH, "other": DEFAULT_CAPACITY_PER_LANE_VPH},
            "speedDefaultKph": SPEED_DEFAULT_KPH,
            "enginesPerStation": ENGINES_PER_STATION,
            "notes": [
                "Zones are grid cells over residential streets, not official evacuation zones.",
                "Homes and vehicles are synthetic estimates from street length, not Census counts.",
                "Each OSM fire station is given one engine; real staffing is not modelled.",
            ],
        },
        "classes": class_list,
        "names": names,
        "nodes": nodes,
        "edges": edges,
        "zones": zones,
        "exits": exits,
        "stations": stations,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--output", type=Path, default=Path("app/public/dispatch/east-bay-hills.json"))
    args = parser.parse_args()
    area = build()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(area, separators=(",", ":")) + "\n")
    print(
        f"{args.output}: {len(area['nodes'])} nodes, {len(area['edges'])} edges, {len(area['zones'])} zones, "
        f"{len(area['exits'])} exits, {len(area['stations'])} stations, "
        f"{sum(z['vehicles'] for z in area['zones'])} vehicles"
    )


if __name__ == "__main__":
    main()
