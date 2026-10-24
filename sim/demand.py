"""Census-grounded evacuation demand and a derived zone-to-block-group crosswalk (Camp Fire package).

Inputs are layers of a verified `camp-2018-evacuation` package with `layers_normalizer_version`
(call after `sim.network.load_road_network`, which checks every artifact hash):
  - `population_units.geojson`: TIGER 2018 block groups (BGs) with ACS 2014-2018 counts (`observed`);
  - `evacuation_zones.geojson`: NIST Table 11 zone IDs and names, **without polygons**;
  - `events.jsonl`: Table 11 order/warning requests, Table 10 ECC orders, CodeRED alerts;
  - `curated/nist-zone-requests-table.json`: Table 11 rows, which tie CodeRED times to zones;
  - `shelters.geojson`: NIST temporary refuge areas (TRAs) with place text and active periods;
  - `fire_observations_reconstructed.geojson`: NIST fire observations with corridor sheet names;
  - `terrain_grid.json`: USGS 3DEP elevation, used only to split roads into lower and upper halves.

Demand (derived): one DemandZone per Butte County BG that the crosswalk links to an order or
warning. Evacuating vehicles = households x min(vehicles available, VEHICLES_TAKEN_CAP)
x EVACUATION_PARTICIPATION, scaled by the BG's area share inside the road extract.
Households with no vehicle are counted, not converted to vehicles.

Crosswalk (derived): zone polygons are missing, so each zone is linked to BGs through keys
present in the package. There is no high-confidence mapping. Keys, by zone:
  - place anchor (medium): TRAs whose location text ends in the community name (", Concow");
  - road name (medium): the zone names an OSM road ("Pulga" -> Pulga Road); a BG matches if
    it holds >= ROAD_MATCH_MIN_M or >= ROAD_MATCH_MIN_SHARE of the road;
  - road half (low): "Lower/Upper X" keeps the half of road X below/above its length-weighted
    median elevation, "North/South X" the half north/south of its median latitude;
  - corridor (medium): a NIST fire-observation corridor sheet with the zone's name
    ("Butte Creek Canyon"), >= MIN_ANCHOR_OBS observations in the BG;
  - co-dissemination (low): a zone with no other key takes the BGs of the zones that Table 11
    lists with the same CodeRED time;
  - Paradise numbered zones: located only by CodeRED text "<Road> in Paradise" (low) for the
    zones Table 11 ties to that message; otherwise they are not assigned individually.
The Town of Paradise BG set holds BGs with a TRA written "..., Paradise" or with
>= MIN_ANCHOR_OBS fire observations on a corridor sheet named after a street that only
Paradise TRAs mention. Magalia likewise, from TRAs and the "Magalia and Coutolenc Rd" sheet.

Order rule: every order or warning (IC request, ECC order, or CodeRED initial message) is
emitted as a derived event targeting all BGs of its zones; the engine applies the first
notice per BG, so a BG with several candidate zones gets the earliest one. An ECC order that
lists all fourteen Paradise zones applies to every Paradise-set BG; Paradise numbered zones
without a locating key contribute nothing on their own, so their warnings are not assigned.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from sim.events import canonical_road_name
from sim.geo import EARTH_RADIUS_M, Grid, rasterize
from sim.history import parse_utc
from sim.traffic import DemandZone, Destination, RoadNetwork, TrafficEvent

LOCAL_TZ = ZoneInfo("America/Los_Angeles")
INCIDENT_LOCAL_DATE = datetime(2018, 11, 8, tzinfo=LOCAL_TZ)  # Table 11 hh:mm counts from this midnight
ZONE_COUNTY_FIPS = "06007"  # NIST zones are Butte County / Town of Paradise zones

# Demand assumptions (not observed).
VEHICLES_TAKEN_CAP = 2  # a household takes at most this many of its available vehicles (literature: 1-2)
EVACUATION_PARTICIPATION = 1.0  # share of households in a noticed BG that evacuate by car
CLIP_CELL_M = 100.0  # raster cell for a BG's area share inside the road extract

# Crosswalk thresholds (derived-key rules, not observed).
ROAD_MATCH_MIN_M = 1000.0
ROAD_MATCH_MIN_SHARE = 0.25
MIN_ANCHOR_OBS = 5  # fire observations of a corridor sheet needed inside a BG
TRA_SNAP_MAX_M = 300.0
LOCATOR_BAND_DEG = 0.002  # latitude band of the point-in-BG edge index

PARADISE_ZONE_PREFIX = "paradise-2017-zone-"
COUNTY_ZONE_PREFIX = "camp-2018-zone-"
MAGALIA_CORRIDOR = "Magalia and Coutolenc Rd"
QUALIFIERS = {"lower": "lower", "l": "lower", "upper": "upper", "u": "upper",
              "north": "north", "n": "north", "south": "south", "s": "south"}
# Zone name -> OSM road name where the name is not the road's own name.
ROAD_ALIASES = {
    "fir": ("fir haven drive",),  # CodeRED wrote these zones as "N Fir Haven, S Fir Haven"
    "powellton": ("powellton", "powelton", "powelltown"),  # spellings in OSM and CodeRED
    "carnegie colter": ("carnegie",),
}
ZONE_PLACE_ANCHOR = {"camp-2018-zone-concow": "Concow", "camp-2018-zone-old-magalia": "Magalia"}
ZONE_CORRIDOR = {"camp-2018-zone-butte-creek": "Butte Creek Canyon", "camp-2018-zone-foothills": "Foothills"}

NOTICE_TYPES = ("evacuation_order", "evacuation_warning")
CONFIDENCE_RANK = {"medium": 2, "low": 1}

ASSUMPTIONS = [
    f"Evacuating vehicles per household = min(vehicles available, {VEHICLES_TAKEN_CAP}) from ACS B25044 "
    f"households by vehicles available (5+ counted as 5), with participation {EVACUATION_PARTICIPATION:g}; "
    "both are assumptions, and shadow evacuation outside noticed block groups is not modelled.",
    "Households with no vehicle are reported as needing assistance and are not converted to vehicles; "
    "rides with neighbours, buses, and on-foot evacuation are not modelled.",
    f"A block group's households are scaled by its area share inside the road extract bbox (raster of "
    f"{CLIP_CELL_M:g} m cells), assuming households are spread evenly over the block group.",
    "Vehicles start at road nodes inside the block group polygon (round-robin); ACS counts are 2014-2018 "
    "averages, not November 2018 occupancy.",
    "Evacuation zone polygons are missing; block groups are linked to zones through a derived crosswalk "
    "(place text of NIST TRAs, OSM road names, NIST fire-observation corridor names, Table 11 CodeRED "
    "co-dissemination). Each link records its method and confidence; none is high confidence.",
    "A block group with several candidate zones takes the earliest order and the earliest warning among them. "
    "The ECC order for all of Paradise (08:03 local) applies to every block group of the derived Paradise set; "
    "Paradise numbered zones are placed individually only where a CodeRED message names a road in Paradise.",
    "County zones (camp-2018-zone-*) are assumed to lie outside the derived Paradise set; 'Lower' county "
    "zones are also assumed to lie outside the derived Magalia set.",
    "Order times are the earliest of NIST Table 11 Incident Commander requests, Table 10 ECC orders, and "
    "initial CodeRED messages; resident receipt of any notice is not established.",
]


@dataclass(frozen=True)
class BlockGroup:
    geoid: str
    name: str
    county_fips: str
    households: int
    population: int
    population_65_plus: int
    households_no_vehicle: int
    moe_households_no_vehicle: int
    households_by_vehicles: tuple[tuple[int, int, int], ...]  # (vehicles available, households, MOE); 5 = 5+
    vehicles_available_total: int
    source_locator: str
    geometry: dict
    bbox: tuple[float, float, float, float]


@dataclass(frozen=True)
class ZoneMapping:
    zone_id: str
    zone_name: str
    geoids: tuple[str, ...]
    method: str  # place_anchor | road_name | road_half | corridor | co_dissemination | paradise_road | none
    confidence: str | None  # medium | low; None when unmapped
    basis: str


@dataclass(frozen=True)
class Notice:
    event: dict  # source event from events.jsonl
    type: str  # evacuation_order | evacuation_warning
    zone_ids: tuple[str, ...]
    source: str  # human-readable source for labels
    link: str  # how the zones were taken from the event


def _read(package: Path, relative: str):
    return json.loads((package / relative).read_text())


def _bbox(geometry: dict) -> tuple[float, float, float, float]:
    polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    xs = [q[0] for poly in polygons for q in poly[0]]
    ys = [q[1] for poly in polygons for q in poly[0]]
    return min(xs), min(ys), max(xs), max(ys)


def load_block_groups(package: Path) -> list[BlockGroup]:
    out = []
    for f in _read(package, "normalized/population_units.geojson")["features"]:
        p = f["properties"]
        by_veh = []
        for key, row in p["households_by_vehicles_available"].items():
            k = 5 if key == "5_plus" else int(key)
            by_veh.append((k, row["households"], row["moe"]))
        out.append(BlockGroup(
            geoid=p["geoid"], name=p["name"], county_fips=p["county_fips"], households=p["households"],
            population=p["population"], population_65_plus=p["population_65_plus"],
            households_no_vehicle=p["households_no_vehicle"], moe_households_no_vehicle=p["moe_households_no_vehicle"],
            households_by_vehicles=tuple(sorted(by_veh)), vehicles_available_total=p["vehicles_available_total"],
            source_locator=p["source_locator"], geometry=f["geometry"], bbox=_bbox(f["geometry"]),
        ))
    return out


def evacuating_vehicles(bg: BlockGroup) -> tuple[float, float]:
    """(vehicles, MOE) before clipping; MOE by root-sum-of-squares of category MOEs (Census approximation)."""
    vehicles = sum(hh * min(k, VEHICLES_TAKEN_CAP) for k, hh, _ in bg.households_by_vehicles)
    moe = math.sqrt(sum((min(k, VEHICLES_TAKEN_CAP) * m) ** 2 for k, _, m in bg.households_by_vehicles))
    return vehicles * EVACUATION_PARTICIPATION, moe * EVACUATION_PARTICIPATION


def _area_share_inside(bg: BlockGroup, bbox: list[float]) -> float:
    grid = Grid.covering(list(bg.bbox), CLIP_CELL_M)
    mask = rasterize(grid, bg.geometry)
    total = inside = 0
    for i, m in enumerate(mask):
        if m:
            total += 1
            lon, lat = grid.cell_center_lonlat(i)
            inside += bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]
    return inside / total if total else 0.0


class _Locator:
    """Point -> BG geoid. The even-odd rule of sim.geo.point_in_geometry, with each BG's ring edges
    bucketed into LOCATOR_BAND_DEG latitude bands so a test reads only the edges that can cross the
    point's latitude (TIGER rings have thousands of vertices). BG parts never overlap, so even-odd over
    all rings of a MultiPolygon equals point_in_geometry's OR over its parts."""

    def __init__(self, bgs: list[BlockGroup]):
        self.index = []
        for bg in bgs:
            bands: dict[int, list[tuple[float, float, float, float]]] = {}
            polygons = [bg.geometry["coordinates"]] if bg.geometry["type"] == "Polygon" else bg.geometry["coordinates"]
            for ring in (r for poly in polygons for r in poly):
                for (x0, y0, *_), (x1, y1, *_) in zip(ring, ring[1:] + ring[:1]):
                    for b in range(math.floor(min(y0, y1) / LOCATOR_BAND_DEG), math.floor(max(y0, y1) / LOCATOR_BAND_DEG) + 1):
                        bands.setdefault(b, []).append((x0, y0, x1, y1))
            self.index.append((bg.geoid, bg.bbox, bands))

    def __call__(self, lon: float, lat: float) -> str | None:
        band = math.floor(lat / LOCATOR_BAND_DEG)
        for geoid, (bx0, by0, bx1, by1), bands in self.index:
            if not (bx0 <= lon <= bx1 and by0 <= lat <= by1):
                continue
            inside = False
            for x0, y0, x1, y1 in bands.get(band, ()):
                if (y0 <= lat) != (y1 <= lat) and lon < x0 + (lat - y0) * (x1 - x0) / (y1 - y0):
                    inside = not inside
            if inside:
                return geoid
        return None


class _Terrain:
    def __init__(self, package: Path):
        raw = _read(package, "normalized/terrain_grid.json")
        self.lon0, self.lat0 = raw["origin_lon"], raw["origin_lat"]
        self.dlon, self.dlat = raw["cell_deg"], raw.get("cell_deg_lat", raw["cell_deg"])
        self.ncols, self.nrows = raw["ncols"], raw["nrows"]
        self.z = raw["elevation_m"]

    def at(self, lon: float, lat: float) -> float | None:
        c, r = math.floor((lon - self.lon0) / self.dlon), math.floor((lat - self.lat0) / self.dlat)
        if 0 <= c < self.ncols and 0 <= r < self.nrows:
            return self.z[r * self.ncols + c]
        return None


def _weighted_median(pairs: list[tuple[float, float]]) -> float:
    pairs = sorted(pairs)
    half, acc = sum(w for _, w in pairs) / 2, 0.0
    for v, w in pairs:
        acc += w
        if acc >= half:
            return v
    return pairs[-1][0]


def _zone_name(z: dict) -> str:
    return z.get("name_expanded") or z["name"]


def _norm(text: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text.lower()).split())


def _local_minutes(at: datetime) -> int:
    return round((at.astimezone(LOCAL_TZ) - INCIDENT_LOCAL_DATE).total_seconds() / 60)


def _table_minutes(hhmm: str | None) -> int | None:
    if not hhmm:
        return None
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def build_crosswalk(package: Path, network: RoadNetwork, bgs: list[BlockGroup]) -> dict:
    """Zone -> BG mappings, the derived Paradise and Magalia sets, and per-BG lookups."""
    zones = {f["properties"]["zone_id"]: f["properties"] for f in
             _read(package, "normalized/evacuation_zones.geojson")["features"]}
    table11 = _read(package, "curated/nist-zone-requests-table.json")["table_11"]["rows"]
    tras = [f for f in _read(package, "normalized/shelters.geojson")["features"]
            if f["properties"].get("kind") == "temporary_refuge" and f["geometry"]]
    observations = [f for f in _read(package, "normalized/fire_observations_reconstructed.geojson")["features"]
                    if f["geometry"]]
    butte = [bg for bg in bgs if bg.county_fips == ZONE_COUNTY_FIPS]
    locate = _Locator(butte)

    # Anchors: TRA community text and corridor-sheet observation counts per BG.
    tra_bg: dict[str, list[tuple[str, str]]] = {}  # community -> [(geoid, tra_id)]
    tra_text: dict[str, list[str]] = {}  # community -> lowercase name + location texts
    for f in tras:
        p = f["properties"]
        community = p["location_as_written"].rsplit(",", 1)[-1].strip()
        tra_text.setdefault(community, []).append(f"{p['name']} {p['location_as_written']}".lower())
        geoid = locate(*f["geometry"]["coordinates"])
        if geoid:
            tra_bg.setdefault(community, []).append((geoid, p["tra_id"]))
    corridor_obs: dict[str, dict[str, int]] = {}  # sheet -> geoid -> count
    for f in observations:
        geoid = locate(*f["geometry"]["coordinates"])
        if not geoid:
            continue
        for sheet in {r.split("!")[0] for r in f["properties"]["corridor_sheet_rows"]}:
            corridor_obs.setdefault(sheet, {}).setdefault(geoid, 0)
            corridor_obs[sheet][geoid] += 1

    def corridor_bgs(sheet: str) -> list[str]:
        return sorted(g for g, n in corridor_obs.get(sheet, {}).items() if n >= MIN_ANCHOR_OBS)

    # Road lengths per BG, one count per two-way segment, located by the segment's first node.
    node_bg = {n: locate(lon, lat) for n, (lon, lat) in network.nodes.items()}
    terrain = _Terrain(package)
    road_parts: dict[str, list[tuple[str, float, float, float]]] = {}  # name -> [(geoid, length, elev, lat)]
    seen_segments = set()
    for e in network.edges:
        if e.segment_id in seen_segments:
            continue
        seen_segments.add(e.segment_id)
        geoid = node_bg.get(e.from_node)
        if geoid is None:
            continue
        lon, lat = e.coords[len(e.coords) // 2]
        z = terrain.at(lon, lat)
        road_parts.setdefault(canonical_road_name(e.name), []).append((geoid, e.length_m, z if z is not None else math.nan, lat))

    county_zone_roads = set()  # base road names of county zones, never used to define the Paradise set
    for zid, z in zones.items():
        if zid.startswith(COUNTY_ZONE_PREFIX):
            words = _norm(_zone_name(z)).split()
            county_zone_roads.update(w for w in words if w not in QUALIFIERS)

    # Town of Paradise set: Paradise TRAs plus corridor sheets named after Paradise-only streets.
    other_text = " ".join(t for c, texts in tra_text.items() if c != "Paradise" for t in texts)
    paradise_text = " ".join(tra_text.get("Paradise", []))
    paradise_sheets = []
    for sheet in sorted(corridor_obs):
        heads = [_norm(part).split()[0] for part in sheet.split(" and ")]
        if any(h in paradise_text and h not in other_text and h not in county_zone_roads for h in heads):
            paradise_sheets.append(sheet)
    paradise_basis: dict[str, list[str]] = {}
    for geoid, tra_id in tra_bg.get("Paradise", []):
        paradise_basis.setdefault(geoid, []).append(tra_id)
    for sheet in paradise_sheets:
        for geoid in corridor_bgs(sheet):
            paradise_basis.setdefault(geoid, []).append(f"obs:{sheet}")
    magalia_basis: dict[str, list[str]] = {}
    for geoid, tra_id in tra_bg.get("Magalia", []):
        magalia_basis.setdefault(geoid, []).append(tra_id)
    for geoid in corridor_bgs(MAGALIA_CORRIDOR):
        magalia_basis.setdefault(geoid, []).append(f"obs:{MAGALIA_CORRIDOR}")
    paradise_set, magalia_set = set(paradise_basis), set(magalia_basis)

    def road_match(names: tuple[str, ...], qualifier: str | None, exclude: set[str]) -> tuple[list[str], str]:
        parts = [p for n in names for p in road_parts.get(n, ())]
        if not parts:
            return [], f"no OSM road named {'/'.join(names)} in Butte County block groups"
        rule = ""
        if qualifier in ("lower", "upper"):
            valid = [p for p in parts if not math.isnan(p[2])]
            median = _weighted_median([(p[2], p[1]) for p in valid])
            parts = [p for p in valid if (p[2] <= median) == (qualifier == "lower")]
            rule = f", {qualifier} half by length-weighted median elevation {median:.0f} m"
        elif qualifier in ("north", "south"):
            median = _weighted_median([(p[3], p[1]) for p in parts])
            parts = [p for p in parts if (p[3] >= median) == (qualifier == "north")]
            rule = f", {qualifier} half by length-weighted median latitude {median:.4f}"
        total = sum(p[1] for p in parts)
        by_bg: dict[str, float] = {}
        for geoid, length, _, _ in parts:
            by_bg[geoid] = by_bg.get(geoid, 0.0) + length
        hits = sorted(g for g, m in by_bg.items()
                      if g not in exclude and (m >= ROAD_MATCH_MIN_M or m >= ROAD_MATCH_MIN_SHARE * total))
        return hits, (f"OSM road {'/'.join(names)}{rule}; BGs with >= {ROAD_MATCH_MIN_M:.0f} m or >= "
                      f"{ROAD_MATCH_MIN_SHARE:.0%} of it" + (f", excluding {len(exclude)} Paradise/Magalia-set BGs"
                                                             if exclude else ""))

    # Table 11 CodeRED co-dissemination groups (same time and kind).
    codered_groups: dict[tuple[str, int], list[str]] = {}
    for row in table11:
        for kind in ("warning", "order"):
            minutes = _table_minutes(row[f"{kind}_codered"])
            if minutes is not None:
                codered_groups.setdefault((kind, minutes), []).append(row["zone_id"])

    mappings: dict[str, ZoneMapping] = {}
    deferred = []
    for zid, z in sorted(zones.items()):
        name = _zone_name(z)
        if zid.startswith(PARADISE_ZONE_PREFIX):
            continue  # located below from CodeRED text, else only through town-wide orders
        exclude = set(paradise_set)
        if zid in ZONE_PLACE_ANCHOR:
            community = ZONE_PLACE_ANCHOR[zid]
            anchor = magalia_basis if community == "Magalia" else {g: [t] for g, t in tra_bg.get(community, [])}
            geoids = sorted(set(anchor) - exclude)
            part_of = _norm(name) != _norm(community)
            mappings[zid] = ZoneMapping(
                zid, name, tuple(geoids), "place_anchor", "low" if part_of else "medium",
                f"BGs holding NIST TRAs written '..., {community}'"
                + (f" or >= {MIN_ANCHOR_OBS} '{MAGALIA_CORRIDOR}' fire observations" if community == "Magalia" else "")
                + ("; the zone is only part of that community" if part_of else ""))
            continue
        if zid in ZONE_CORRIDOR:
            sheet = ZONE_CORRIDOR[zid]
            geoids = sorted(set(corridor_bgs(sheet)) - exclude)
            mappings[zid] = ZoneMapping(zid, name, tuple(geoids), "corridor", "medium",
                                        f"BGs with >= {MIN_ANCHOR_OBS} NIST fire observations on corridor sheet '{sheet}'")
            continue
        words = _norm(name).split()
        qualifier = QUALIFIERS.get(words[0]) if words else None
        base = " ".join(words[1:] if qualifier else words)
        names = ROAD_ALIASES.get(base, (base,))
        if qualifier == "lower":
            exclude |= magalia_set
        geoids, basis = road_match(names, qualifier, exclude)
        if geoids:
            mappings[zid] = ZoneMapping(zid, name, tuple(geoids), "road_half" if qualifier else "road_name",
                                        "low" if qualifier else "medium", basis)
        else:
            deferred.append((zid, name, basis if basis.startswith("no OSM road") else f"no block group passes {basis}"))

    for zid, name, why in deferred:
        peers = sorted({p for group in codered_groups.values() if zid in group for p in group
                        if p != zid and p in mappings})
        geoids = sorted({g for p in peers for g in mappings[p].geoids})
        if geoids:
            mappings[zid] = ZoneMapping(
                zid, name, tuple(geoids), "co_dissemination", "low",
                f"{why}; BGs of zones Table 11 lists with the same CodeRED message: {', '.join(peers)}")
        else:
            mappings[zid] = ZoneMapping(zid, name, (), "none", None, f"{why}; no co-disseminated zone with a key")

    # Paradise numbered zones: CodeRED text "<Road> in Paradise" for the zones Table 11 ties to it.
    alerts = [json.loads(line) for line in (package / "normalized/events.jsonl").read_text().splitlines() if line.strip()]
    for ev in alerts:
        if ev["type"] != "alert_sent" or ev.get("alert_attempt") != "initial":
            continue
        m = re.fullmatch(r"(.+) in Paradise", (ev.get("target") or {}).get("place_name") or "")
        if not m:
            continue
        kind = ev.get("evacuation_status_in_message")
        linked = codered_groups.get((kind, _local_minutes(parse_utc(ev["occurred_at"]))), [])
        road = canonical_road_name(m.group(1))
        geoids, basis = road_match((road,), None, set())
        geoids = [g for g in geoids if g in paradise_set]
        for zid in linked:
            if zid.startswith(PARADISE_ZONE_PREFIX) and geoids:
                mappings[zid] = ZoneMapping(
                    zid, _zone_name(zones[zid]), tuple(geoids), "paradise_road", "low",
                    f"CodeRED {ev['event_id']} '{m.group(0)}' shares Table 11's {kind} CodeRED time with this zone; "
                    f"Paradise-set BGs on {basis}")
    for zid, z in sorted(zones.items()):
        if zid.startswith(PARADISE_ZONE_PREFIX) and zid not in mappings:
            mappings[zid] = ZoneMapping(zid, _zone_name(z), (), "none", None,
                                        "no locating key inside the Town of Paradise; covered by town-wide orders")

    return {
        "zones": zones,
        "mappings": mappings,
        "paradise_set": sorted(paradise_set),
        "paradise_basis": {g: sorted(v) for g, v in sorted(paradise_basis.items())},
        "paradise_corridor_sheets": paradise_sheets,
        "magalia_set": sorted(magalia_set),
        "node_bg": node_bg,
        "codered_groups": codered_groups,
        "paradise_zone_ids": sorted(z for z in zones if z.startswith(PARADISE_ZONE_PREFIX)),
    }


def load_notices(package: Path, crosswalk: dict) -> tuple[list[Notice], list[dict]]:
    """Orders and warnings with zone IDs: Table 11/10 events, and initial CodeRED messages linked to zones
    by their own zone IDs or by Table 11's CodeRED time. Returns (notices, unlinked CodeRED messages)."""
    notices, unlinked = [], []
    for line in (package / "normalized/events.jsonl").read_text().splitlines():
        if not line.strip():
            continue
        ev = json.loads(line)
        target = ev.get("target") or {}
        if ev["type"] in NOTICE_TYPES and target.get("zone_ids"):
            table = "NIST Table 10, Butte County ECC" if ":t10:" in ev["event_id"] else "NIST Table 11 IC request"
            notices.append(Notice(ev, ev["type"], tuple(target["zone_ids"]), table, "event zone IDs"))
        elif ev["type"] == "alert_sent" and ev.get("alert_attempt") == "initial":
            kind = ev.get("evacuation_status_in_message")
            if kind not in ("order", "warning"):
                continue
            if target.get("zone_ids"):
                zone_ids, link = tuple(target["zone_ids"]), "event zone IDs"
            else:
                zone_ids = tuple(crosswalk["codered_groups"].get((kind, _local_minutes(parse_utc(ev["occurred_at"]))), ()))
                link = "Table 11 CodeRED time"
            if not zone_ids:
                unlinked.append({"event_id": ev["event_id"], "at": ev["occurred_at"], "kind": kind,
                                 "place_name": target.get("place_name")})
                continue
            notices.append(Notice(ev, f"evacuation_{kind}", zone_ids, f"CodeRED {kind}", link))
    return notices, unlinked


def notice_targets(notice: Notice, crosswalk: dict) -> dict[str, str]:
    """BG geoid -> confidence of the best crosswalk link by which the notice reaches it."""
    reached: dict[str, str] = {}

    def add(geoids, confidence: str) -> None:
        for g in geoids:
            if g not in reached or CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[reached[g]]:
                reached[g] = confidence

    if notice.type == "evacuation_order" and set(crosswalk["paradise_zone_ids"]) <= set(notice.zone_ids):
        add(crosswalk["paradise_set"], "medium")  # an order for all of Paradise
    for zid in notice.zone_ids:
        m = crosswalk["mappings"].get(zid)
        if m and m.geoids:
            add(m.geoids, m.confidence)
    return dict(sorted(reached.items()))


def _confidence_text(reached: dict[str, str]) -> str:
    counts = {c: sum(1 for v in reached.values() if v == c) for c in CONFIDENCE_RANK}
    parts = [f"{c} confidence" + (f" for {n}" if len(reached) != n else "") for c, n in counts.items() if n]
    return ", ".join(parts)


def tra_destinations(package: Path, network: RoadNetwork) -> tuple[list[Destination], list[TrafficEvent], list[dict]]:
    """NIST TRAs as `temporary_refuge` destinations at their nearest road node, with open/close events
    carrying destination_id, and a comparison table of NIST occupant ranges (capacity unknown)."""
    m_per_deg = math.radians(1) * EARTH_RADIUS_M
    destinations, events, table = [], [], []
    for f in _read(package, "normalized/shelters.geojson")["features"]:
        p = f["properties"]
        if p.get("kind") != "temporary_refuge" or not f["geometry"]:
            continue
        lon, lat = f["geometry"]["coordinates"]
        kx = math.cos(math.radians(lat))
        dist, node = min((math.hypot((x - lon) * kx, y - lat) * m_per_deg, n) for n, (x, y) in network.nodes.items())
        row = {"destination_id": f"tra:{p['tra_id']}", "name": p["name"], "location_as_written": p["location_as_written"],
               "active_periods_utc": p["active_periods_utc"], "snap_m": round(dist),
               "occupancy_reports": p["occupancy_reports"], "evidence_class": p["evidence_class"],
               "source_locator": p["source_locator"], "included": dist <= TRA_SNAP_MAX_M}
        table.append(row)
        if not row["included"]:
            continue
        dest_id = row["destination_id"]
        destinations.append(Destination(dest_id, f"{p['tra_id']}: {p['name']}", "temporary_refuge", node,
                                        network.nodes[node], None))
        for k, (opened, closed) in enumerate(p["active_periods_utc"]):
            for ev_type, at, verb in (("shelter_opened", opened, "formed"), ("shelter_closed", closed, "ended")):
                events.append(TrafficEvent(
                    id=f"{dest_id}:{k}:{ev_type}", at=parse_utc(at), type=ev_type,
                    label=f"{p['tra_id']} {verb} (NIST Appendix I): {p['name']}",
                    evidence_class=p["evidence_class"], time_precision=p["time_precision"],
                    destination_id=dest_id, source_id=p["source_id"], source_locator=p["source_locator"]))
    return destinations, events, table


def grounded_demand(package: Path, network: RoadNetwork) -> dict:
    """DemandZones, derived notice events, and the demand/crosswalk report for the scenario."""
    manifest = _read(package, "manifest.json")
    extract_bbox = manifest["requested_bbox"]
    bgs = load_block_groups(package)
    crosswalk = build_crosswalk(package, network, bgs)
    notices, unlinked = load_notices(package, crosswalk)

    reached: dict[str, dict] = {}  # geoid -> first order/warning (at, event id, confidence)
    planned = []
    for n in notices:
        targets = notice_targets(n, crosswalk)
        planned.append((n, targets))
        at = parse_utc(n.event["occurred_at"])
        for g, confidence in targets.items():
            slot = reached.setdefault(g, {})
            if n.type not in slot or at < slot[n.type][0]:
                slot[n.type] = (at, n.event["event_id"], confidence)

    by_geoid = {bg.geoid: bg for bg in bgs}
    demand_geoids = sorted(set(reached) | set(crosswalk["paradise_set"]))
    node_bg = crosswalk["node_bg"]
    origins: dict[str, list[str]] = {}
    for node, g in node_bg.items():
        if g is not None:
            origins.setdefault(g, []).append(node)

    zones, stats = [], []
    for g in demand_geoids:
        bg = by_geoid[g]
        share = _area_share_inside(bg, extract_bbox)
        vehicles, moe = evacuating_vehicles(bg)
        nodes = tuple(sorted(origins.get(g, ())))
        veh = round(vehicles * share) if nodes else 0
        first = reached.get(g, {})
        order, warning = first.get("evacuation_order"), first.get("evacuation_warning")
        zones.append(DemandZone(id=f"bg:{g}", name=bg.name.replace(", Butte County, California", ""),
                                households=round(bg.households * share), vehicles=veh, origin_nodes=nodes,
                                geometry=bg.geometry))
        stats.append({
            "zone_id": f"bg:{g}", "geoid": g, "population": bg.population,
            "population_in_extract": round(bg.population * share), "population_65_plus": bg.population_65_plus,
            "households": bg.households, "households_in_extract": round(bg.households * share),
            "households_no_vehicle": bg.households_no_vehicle, "moe_households_no_vehicle": bg.moe_households_no_vehicle,
            "households_no_vehicle_in_extract": round(bg.households_no_vehicle * share),
            "vehicles_available_total": bg.vehicles_available_total,
            "evacuating_vehicles": veh, "evacuating_vehicles_moe": round(moe * share),
            "area_share_in_extract": round(share, 3), "origin_nodes": len(nodes),
            "vehicles_dropped_no_origin": 0 if nodes else round(vehicles * share),
            "in_paradise_set": g in crosswalk["paradise_basis"], "in_magalia_set": g in crosswalk["magalia_set"],
            "candidate_zones": sorted(z for z, m in crosswalk["mappings"].items() if g in m.geoids),
            "first_order": None if not order else {"at": order[0].isoformat().replace("+00:00", "Z"),
                                                   "event_id": order[1], "confidence": order[2]},
            "first_warning": None if not warning else {"at": warning[0].isoformat().replace("+00:00", "Z"),
                                                       "event_id": warning[1], "confidence": warning[2]},
            "evidence": {"population": "observed", "evacuating_vehicles": "derived", "crosswalk": "derived"},
            "source_locator": bg.source_locator,
        })

    events = []
    names = {zid: _zone_name(z) for zid, z in crosswalk["zones"].items()}
    for n, targets in planned:
        if not targets:
            continue
        kind = "Evacuation order" if n.type == "evacuation_order" else "Evacuation warning"
        town_wide = set(crosswalk["paradise_zone_ids"]) <= set(n.zone_ids) and n.type == "evacuation_order"
        what = "all of Paradise" if town_wide else ", ".join(names.get(z, z) for z in n.zone_ids)
        events.append(TrafficEvent(
            id=f"{n.event['event_id']}:bg", at=parse_utc(n.event["occurred_at"]), type=n.type,
            label=f"{kind} ({n.source}): {what} → {len(targets)} block groups (derived crosswalk, {_confidence_text(targets)})",
            evidence_class=n.event["evidence_class"], time_precision=n.event["time_precision"],
            zone_ids=tuple(f"bg:{g}" for g in targets), source_id=n.event["source_id"],
            source_locator=n.event.get("source_locator")))

    mappings = crosswalk["mappings"]
    excluded = [bg for bg in bgs if bg.geoid not in set(demand_geoids)]
    demand_set = set(demand_geoids)
    adjacent = {node_bg[e.to_node] for e in network.edges
                if node_bg.get(e.from_node) in demand_set and node_bg.get(e.to_node) is not None}
    report = {
        "evidence_class": "derived",
        "parameters": {"vehicles_taken_cap": VEHICLES_TAKEN_CAP, "evacuation_participation": EVACUATION_PARTICIPATION,
                       "clip_cell_m": CLIP_CELL_M, "road_match_min_m": ROAD_MATCH_MIN_M,
                       "road_match_min_share": ROAD_MATCH_MIN_SHARE, "min_anchor_obs": MIN_ANCHOR_OBS,
                       "extract_bbox": extract_bbox},
        "totals": {
            "block_groups": len(zones),
            "population": sum(s["population_in_extract"] for s in stats),
            "households": sum(s["households_in_extract"] for s in stats),
            "households_no_vehicle": sum(s["households_no_vehicle_in_extract"] for s in stats),
            "population_65_plus": sum(round(s["population_65_plus"] * s["area_share_in_extract"]) for s in stats),
            "evacuating_vehicles": sum(z.vehicles for z in zones),
            "evacuating_vehicles_moe": round(math.sqrt(sum(s["evacuating_vehicles_moe"] ** 2 for s in stats))),
            "vehicles_dropped_no_origin": sum(s["vehicles_dropped_no_origin"] for s in stats),
            "excluded_block_groups": len(excluded),
            "excluded_population": sum(bg.population for bg in excluded),
        },
        "paradise_set": crosswalk["paradise_basis"],
        "paradise_corridor_sheets": crosswalk["paradise_corridor_sheets"],
        "magalia_set": crosswalk["magalia_set"],
        "crosswalk": [
            {"zone_id": m.zone_id, "zone_name": m.zone_name, "geoids": list(m.geoids), "method": m.method,
             "confidence": m.confidence, "basis": m.basis}
            for m in sorted(mappings.values(), key=lambda m: m.zone_id)
        ],
        "unmapped_zones": sorted(m.zone_id for m in mappings.values() if not m.geoids),
        "codered_unlinked": unlinked,
        "notices": [
            {"event_id": n.event["event_id"], "at": n.event["occurred_at"], "type": n.type, "source": n.source,
             "zone_link": n.link, "zone_ids": list(n.zone_ids), "block_groups": targets}
            for n, targets in planned
        ],
        "never_ordered": [s["zone_id"] for s in stats if s["first_order"] is None],
        # Excluded Butte BGs joined by a road edge to a demand BG: where a missing crosswalk link would show.
        "adjacent_excluded": [
            {"geoid": g, "name": by_geoid[g].name, "population": by_geoid[g].population}
            for g in sorted(adjacent - set(demand_geoids))
            if by_geoid[g].county_fips == ZONE_COUNTY_FIPS
        ],
        "zones": stats,
    }
    return {"zones": tuple(zones), "events": tuple(events), "report": report}
