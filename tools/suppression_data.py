"""Load, validate and summarise the firefighting resource data for the suppression simulation.

Files (all under tools/):

- suppression_resources.json: resource types, performance, operating constraints and
  response times. Every number is a "leaf" object with a `value`, a `unit`, and either
  `source_id` + `page` (a key of `sources`) or `assumption: true` + `reason`.
- ca_fire_bases.json: California fire stations, conservation camps, helitack bases, air
  attack bases and dispatch centers from the CAL FIRE facilities layer (see
  docs/suppression-data.md for licence and gaps).

Commands (standard library only):

    python3 -m tools.suppression_data                  # validate and print a summary
    python3 -m tools.suppression_data --refresh-bases  # re-download the CAL FIRE layer,
                                                       # rewrite ca_fire_bases.json, print size and SHA-256
    python3 -m tools.suppression_data --bases-from raw.geojson   # rebuild from a saved download

Units are the sources' own (gallons, feet, chains, lb, knots); use the converters below at
the simulator boundary. Coordinates are WGS84 longitude/latitude in degrees.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
RESOURCES_PATH = TOOLS / "suppression_resources.json"
BASES_PATH = TOOLS / "ca_fire_bases.json"

FACILITIES_QUERY_URL = (
    "https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/ArcGIS/rest/services/"
    "CAL_FIRE_Facilities_for_Wildland_Fire_Protection_-_Public_View/FeatureServer/0/query"
)
FACILITIES_PARAMS = {
    "where": "1=1",
    "outFields": "*",
    "outSR": "4326",
    "f": "geojson",
    "resultRecordCount": "3000",
}

# ---- unit conversions -------------------------------------------------------------------
METERS_PER_CHAIN = 20.1168
METERS_PER_FOOT = 0.3048
LITERS_PER_GALLON = 3.78541
KMH_PER_KNOT = 1.852
KG_PER_POUND = 0.453592


def chains_per_hour_to_m_per_hour(chains_per_hour: float) -> float:
    return chains_per_hour * METERS_PER_CHAIN


def feet_to_m(feet: float) -> float:
    return feet * METERS_PER_FOOT


def knots_to_kmh(knots: float) -> float:
    return knots * KMH_PER_KNOT


def pounds_to_tonnes(pounds: float) -> float:
    return pounds * KG_PER_POUND / 1000.0


# ---- loading and validation -------------------------------------------------------------
def load_resources(path: Path = RESOURCES_PATH) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def load_bases(path: Path = BASES_PATH) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def is_leaf(node: object) -> bool:
    return isinstance(node, dict) and "value" in node


def iter_leaves(node: object, path: str = ""):
    """Yield (path, leaf) for every leaf object under `node` (the `sources` block is skipped)."""
    if is_leaf(node):
        yield path, node
    elif isinstance(node, dict):
        for key, child in node.items():
            if not path and key == "sources":
                continue
            yield from iter_leaves(child, f"{path}.{key}" if path else key)
    elif isinstance(node, list):
        for index, child in enumerate(node):
            yield from iter_leaves(child, f"{path}[{index}]")


def _numbers_outside_leaves(node: object, path: str = ""):
    if is_leaf(node):
        return
    if isinstance(node, bool):
        return
    if isinstance(node, (int, float)):
        yield path
    elif isinstance(node, dict):
        for key, child in node.items():
            if not path and key == "sources":
                continue
            yield from _numbers_outside_leaves(child, f"{path}.{key}" if path else key)
    elif isinstance(node, list):
        for index, child in enumerate(node):
            yield from _numbers_outside_leaves(child, f"{path}[{index}]")


def validate_resources(data: dict) -> list[str]:
    """Return a list of problems (empty when the file is valid)."""
    problems: list[str] = []
    sources = data.get("sources")
    if not isinstance(sources, dict) or not sources:
        return ["missing sources block"]
    for sid, src in sources.items():
        for field in ("title", "url", "access", "licence"):
            if not isinstance(src.get(field), str) or not src[field].strip():
                problems.append(f"source {sid}: missing {field}")
    leaves = list(iter_leaves(data))
    if not leaves:
        problems.append("no leaves found")
    for path, leaf in leaves:
        if not isinstance(leaf.get("unit"), str) or not leaf["unit"].strip():
            problems.append(f"{path}: missing unit")
        if leaf.get("assumption") is True:
            reason = leaf.get("reason")
            if not isinstance(reason, str) or len(reason.strip()) < 20:
                problems.append(f"{path}: assumption without a reason")
            if "source_id" in leaf:
                problems.append(f"{path}: assumption must not carry a source_id")
        else:
            sid = leaf.get("source_id")
            if sid not in sources:
                problems.append(f"{path}: unknown source_id {sid!r}")
            if not isinstance(leaf.get("page"), str) or not leaf["page"].strip():
                problems.append(f"{path}: sourced value without page")
    for path in _numbers_outside_leaves({k: v for k, v in data.items() if k != "meta"}):
        problems.append(f"{path}: number outside a leaf (unsourced)")
    return problems


BASE_TYPES = {
    "FSA": "Fire Station - Schedule A",
    "FSB": "Fire Station - Schedule B",
    "FSAB": "Fire Station - Schedule A/B",
    "FSL": "Fire Station - Local",
    "FSCC": "Fire Station - Contract County (Greybook)",
    "FSO": "Fire Station - Other",
    "CC": "Conservation Camp",
    "FCFFC": "Fire Center - Firefighter Crews",
    "HB": "Helitack Base",
    "AAB": "Air Attack Base",
    "ECC": "Emergency Command Center",
    "ICC": "Interagency Emergency Command Center",
}
STATION_TYPES = {"FSA", "FSB", "FSAB", "FSL", "FSCC", "FSO"}
CA_BBOX = (-124.6, 32.4, -114.0, 42.1)  # west, south, east, north
# CAL FIRE named these bases for retrofitted C-130H airtankers (House testimony, 2019, p.4).
PLANNED_C130_2019 = ("McClellan", "Ramona", "Fresno", "Paso Robles", "Chico")


def agency_of(owner: str | None, funding: str | None) -> str:
    """Coarse operating agency from the layer's OWNER and FUNDING codes."""
    if owner == "STATE":
        return "CAL FIRE (state-owned)"
    if owner == "FEDERAL" or funding == "F":
        return "Federal"
    if funding in ("A", "B", "C"):
        return "Local government under CAL FIRE Schedule A/B agreement"
    if funding == "G":
        return "Contract county (Greybook)"
    if funding == "L":
        return "Local government"
    return "Unknown"


def build_bases(raw: bytes, retrieved: str, source_url: str = FACILITIES_QUERY_URL) -> dict:
    """Filter the raw GeoJSON download to active fire-response facilities."""
    collection = json.loads(raw)
    records = []
    for feature in collection["features"]:
        props = feature["properties"]
        kind = props.get("TYPE")
        if kind not in BASE_TYPES or props.get("FACILITY_STATUS") != "Active":
            continue
        geometry = feature.get("geometry")
        if not geometry:
            continue
        lon, lat = geometry["coordinates"][:2]
        record = {
            "id": f"calfire-fac-{props['OBJECTID']}",
            "name": props.get("NAME"),
            "cad_name": props.get("CAD_NAME"),
            "type": kind,
            "unit": props.get("UNIT") or props.get("CDF_UNIT"),
            "county": props.get("COUNTY"),
            "city": props.get("CITY"),
            "owner": props.get("OWNER"),
            "funding": props.get("FUNDING"),
            "staffing": props.get("STAFFING"),
            "agency": agency_of(props.get("OWNER"), props.get("FUNDING")),
            "lon": round(lon, 5),
            "lat": round(lat, 5),
        }
        if kind == "AAB" and any(str(record["name"]).startswith(n) for n in PLANNED_C130_2019):
            record["planned_c130_airtanker_2019"] = True
        records.append(record)
    records.sort(key=lambda r: (str(r["unit"]), r["type"], str(r["name"])))
    return {
        "meta": {
            "title": "California fire stations, camps, helitack and air attack bases",
            "source": {
                "name": "CAL FIRE Facilities for Wildland Fire Protection - Public View",
                "query_url": source_url,
                "retrieved": retrieved,
                "raw_features": len(collection["features"]),
                "raw_bytes": len(raw),
                "raw_sha256": hashlib.sha256(raw).hexdigest(),
                "licence": "No open licence stated on the item: CAL FIRE disclaimer of warranties only, contact calfire.egis@fire.ca.gov. Public state data; credit CAL FIRE and contract counties.",
                "attribution": "California Department of Forestry and Fire Protection, Contract Counties",
            },
            "filter": "FACILITY_STATUS = Active and TYPE in " + ", ".join(sorted(BASE_TYPES)),
            "type_names": BASE_TYPES,
            "coordinates": "WGS84, lon/lat degrees (GeoJSON order), 5 decimals",
            "fields_dropped": ["ADDRESS", "ZIP", "PHONE_NUM", "AKA", "GlobalID", "CDF_UNIT (kept as unit when UNIT empty)"],
            "resources": "The layer carries no apparatus, engine or crew counts. See suppression_resources.json deployment for statewide counts and the per-station estimate.",
            "owner_codes": "STATE, COUNTY, CITY, FEDERAL, TRIBAL, FIRE DISTRICT, DISTRICT OTHER, PRIVATE",
            "funding_codes": "A Schedule A, B Schedule B, C combined A/B, L local, G Greybook, F federal",
            "staffing_codes": "P paid, V volunteer, C combined, N not staffed, null unknown",
            "record_count": len(records),
        },
        "bases": records,
    }


def validate_bases(data: dict) -> list[str]:
    problems: list[str] = []
    meta = data.get("meta", {})
    source = meta.get("source", {})
    if not re.fullmatch(r"[0-9a-f]{64}", str(source.get("raw_sha256", ""))):
        problems.append("meta.source.raw_sha256 is not a SHA-256")
    for field in ("retrieved", "licence", "query_url", "attribution"):
        if not source.get(field):
            problems.append(f"meta.source.{field} missing")
    bases = data.get("bases", [])
    if meta.get("record_count") != len(bases):
        problems.append("record_count does not match bases length")
    seen: set[str] = set()
    west, south, east, north = CA_BBOX
    for record in bases:
        rid = record.get("id")
        if rid in seen:
            problems.append(f"duplicate id {rid}")
        seen.add(rid)
        if record.get("type") not in BASE_TYPES:
            problems.append(f"{rid}: bad type {record.get('type')}")
        lon, lat = record.get("lon"), record.get("lat")
        if not (isinstance(lon, (int, float)) and isinstance(lat, (int, float))):
            problems.append(f"{rid}: missing coordinates")
        elif not (west <= lon <= east and south <= lat <= north):
            problems.append(f"{rid}: outside California ({lon}, {lat})")
        if not record.get("name"):
            problems.append(f"{rid}: missing name")
        if not record.get("agency"):
            problems.append(f"{rid}: missing agency")
    return problems


# ---- numeric helpers for the simulator --------------------------------------------------
FUEL_GROUPS = {
    "grass": 0,  # fuel models 1, 2
    "chaparral": 1,  # fuel model 4
    "brush": 2,  # fuel models 5, 6
    "timber": 3,  # fuel models 8, 9, 10
}


def crew_line_rate_m_per_h(data: dict, crew_type: int, fuel_group: str, mode: str = "direct") -> float:
    """Sustained line rate of one 20-person crew (Broyles 2011 Table 2), metres per hour."""
    table = data["hand_crews"][f"production_sustained_2011_{mode}"]["value"]
    chains = table[f"type{crew_type}"]["chains_per_hour"][FUEL_GROUPS[fuel_group]]
    return chains_per_hour_to_m_per_hour(chains)


_DOZER_SLOPE_COLUMN = {
    (0, True): 0, (0, False): 1,
    (1, True): 2, (1, False): 3,
    (2, True): 4, (2, False): 5,
}


def dozer_line_rate_m_per_h(data: dict, size: str, fuel_model: int, slope_pct: float, uphill: bool) -> float | None:
    """Single-pass dozer line rate (PMS 465 p.140), metres per hour; None above the table's 55% slope.

    `size` is "small_type3", "medium_type2" or "large_type1".
    """
    if slope_pct > 55:
        return None
    slope_class = 0 if slope_pct <= 25 else 1 if slope_pct <= 40 else 2
    rows = data["dozers"]["production_single_pass"]["value"]["rows_by_dozer_size_then_fuel_model"][size]
    for label, values in rows.items():
        if str(fuel_model) in label.split(","):
            return chains_per_hour_to_m_per_hour(values[_DOZER_SLOPE_COLUMN[(slope_class, uphill)]])
    return None


def _parse_length_m(raw: object) -> float | None:
    """Parse an OSM width or maxheight value (metres, "3.5 m", or feet-inches like 13'6")."""
    if raw is None:
        return None
    text = str(raw).strip().lower()
    feet = re.fullmatch(r"(\d+(?:\.\d+)?)'\s*(?:(\d+(?:\.\d+)?)\"?)?", text)
    if feet:
        return feet_to_m(float(feet.group(1)) + float(feet.group(2) or 0) / 12.0)
    match = re.fullmatch(r"(\d+(?:[.,]\d+)?)\s*(m)?", text)
    return float(match.group(1).replace(",", ".")) if match else None


def _parse_tonnes(raw: object) -> float | None:
    if raw is None:
        return None
    match = re.fullmatch(r"(\d+(?:[.,]\d+)?)\s*(t)?", str(raw).strip().lower())
    return float(match.group(1).replace(",", ".")) if match else None


def _parse_kmh(raw: object) -> float | None:
    if raw is None:
        return None
    match = re.fullmatch(r"(\d+)\s*(mph|km/h)?", str(raw).strip().lower())
    if not match:
        return None
    value = float(match.group(1))
    return value * 1.609344 if match.group(2) == "mph" else value


_GRAVEL_LIKE = {"gravel", "fine_gravel", "compacted", "pebblestone"}
_SOFT = {"sand", "grass", "mud"}
_FOOT_ONLY = {"path", "footway", "steps", "bridleway", "cycleway", "pedestrian", "corridor"}
_ORDER = ["grade1", "grade2", "grade3", "grade4", "grade5"]


def road_access(
    data: dict,
    tags: dict,
    grade_pct: float,
    vehicle: str,
    dead_end: bool = False,
    has_turnaround: bool = True,
) -> dict:
    """Can `vehicle` use an OSM way, and how fast? The decision table in docs/suppression-data.md.

    `tags` are the way's OSM tags, `grade_pct` the absolute percent grade derived from the
    elevation model along the way, `vehicle` a key of road_access.vehicle_classes.
    Returns {"passable", "speed_kmh", "rule", "notes"}; speed is None when not passable.
    Nearly every threshold is an ASSUMPTION flagged in suppression_resources.json.
    """
    ra = data["road_access"]
    vclass = ra["vehicle_classes"][vehicle]
    notes: list[str] = []

    def no(rule: str, why: str) -> dict:
        return {"passable": False, "speed_kmh": None, "rule": rule, "notes": notes + [why]}

    highway = tags.get("highway", "")
    grade = abs(grade_pct)
    if highway in _FOOT_ONLY:
        return no("R01", f"highway={highway} is not drivable (hand crews only)")
    speeds = ra["heavy_apparatus_speed_kmh_by_highway"]["value"]
    if highway not in speeds and highway != "track":
        return no("R01", f"highway={highway or 'missing'} not a drivable class")
    if tags.get("emergency") == "no" or (tags.get("motor_vehicle") == "no" and tags.get("emergency") != "yes"):
        return no("R02", "motor vehicles excluded")
    if tags.get("access") in ("private", "no"):
        notes.append("private access: assumed open to emergency vehicles, gate delay unknown")

    surface = tags.get("surface") or ra["default_surface_by_highway"]["value"].get(highway, "paved")
    paved_values = set(ra["paved_surfaces"]["value"])
    paved = surface in paved_values or surface == "paved"
    tracktype = tags.get("tracktype")
    if paved:
        tracktype = "grade1"
    elif tracktype not in _ORDER:
        tracktype = "grade2" if surface in _GRAVEL_LIKE else "grade4" if surface in _SOFT else "grade3"
        notes.append(f"tracktype inferred as {tracktype} from surface={surface}")

    smoothness = tags.get("smoothness")
    if smoothness and smoothness not in ra["allowed_smoothness"][vehicle]["value"]:
        return no("R03", f"smoothness={smoothness} too rough for {vehicle}")
    if not paved and tracktype not in ra["allowed_unpaved_tracktype"][vehicle]["value"]:
        return no("R04", f"{tracktype} not allowed for {vehicle}")

    limit = (ra["max_grade_paved_pct"] if paved else ra["max_grade_unpaved_pct"])[vehicle]["value"]
    if grade > limit:
        return no("R05" if paved else "R06", f"grade {grade:.0f}% above {limit}% limit for {vehicle}")

    width = _parse_length_m(tags.get("width"))
    width_known = width is not None
    if width is None:
        width = ra["default_width_m_by_highway"]["value"].get(highway, 3.0)
    if width < ra["min_lane_width_m"]["value"]:
        return no("R07", f"width {width:.1f} m below the 3.05 m minimum lane")
    height = _parse_length_m(tags.get("maxheight"))
    if height is not None and height < ra["min_vertical_clearance_m"]["value"]:
        return no("R08", f"maxheight {height:.1f} m below 4.11 m")

    gvwr_t = pounds_to_tonnes(vclass["gvwr_lb"]["value"])
    maxweight = _parse_tonnes(tags.get("maxweight"))
    if maxweight is not None and gvwr_t > maxweight:
        return no("R09", f"maxweight {maxweight} t below {vehicle} GVWR {gvwr_t:.1f} t")
    if tags.get("bridge") not in (None, "no") and maxweight is None:
        if (highway in ("track", "service") or not paved) and gvwr_t > pounds_to_tonnes(ra["unknown_bridge_weight_limit_lb"]["value"]):
            return no("R09", "bridge on a track/service/unpaved way with no maxweight; assumed 40,000 lb capacity")

    if dead_end and not has_turnaround and vehicle in ("engine_t1_t2", "tender_support", "tender_tactical"):
        return no("R10", "dead end without a turnaround; heavy apparatus cannot reverse out")

    base = speeds.get(highway)
    if not paved or base is None:
        base = ra["unpaved_speed_kmh"]["value"][tracktype]
    posted = _parse_kmh(tags.get("maxspeed"))
    if posted is not None:
        base = min(base, posted)
    penalty = ra["grade_speed_penalty"]["value"]
    factor = penalty["over_16pct"] if grade > 16 else penalty["over_12pct"] if grade > 12 else penalty["over_8pct"] if grade > 8 else 1.0
    if factor < 1.0:
        notes.append(f"grade {grade:.0f}% slows to x{factor}")
    lanes = tags.get("lanes")
    single = lanes == "1" or width < ra["single_lane_below_width_m"]["value"]
    if single and tags.get("oneway") != "yes":
        factor *= ra["single_lane_speed_factor"]["value"]
        notes.append("single lane" + ("" if width_known else " (width default)"))
    return {"passable": True, "speed_kmh": round(base * factor, 1), "rule": "R11" if paved else "R12", "notes": notes}


# ---- fetching and summary ---------------------------------------------------------------
def fetch_facilities_raw(timeout: int = 90) -> bytes:
    url = FACILITIES_QUERY_URL + "?" + urllib.parse.urlencode(FACILITIES_PARAMS)
    request = urllib.request.Request(url, headers={"User-Agent": "crisistwin-suppression-data/1"})
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed https URL
        return response.read()


def summary(resources: dict, bases: dict) -> str:
    leaves = list(iter_leaves(resources))
    assumed = [p for p, leaf in leaves if leaf.get("assumption")]
    unverified = [
        p for p, leaf in leaves
        if not leaf.get("assumption") and resources["sources"][leaf["source_id"]].get("verified") is False
    ]
    by_source = Counter(leaf["source_id"] for _, leaf in leaves if not leaf.get("assumption"))
    lines = [
        f"suppression_resources.json: {len(leaves)} leaves, {len(leaves) - len(assumed)} sourced "
        f"({len(unverified)} from unverified sources), {len(assumed)} assumptions",
    ]
    for sid, count in by_source.most_common():
        flag = "" if resources["sources"][sid].get("verified", True) else "  [unverified]"
        lines.append(f"  {count:3d}  {sid}{flag}")
    sections = Counter(p.split(".")[0] for p, _ in leaves)
    lines.append("by section: " + ", ".join(f"{k}={v}" for k, v in sections.items()))
    records = bases["bases"]
    lines.append(f"ca_fire_bases.json: {len(records)} active facilities (retrieved {bases['meta']['source']['retrieved']})")
    lines.append("  by type: " + ", ".join(f"{k}={v}" for k, v in sorted(Counter(r["type"] for r in records).items())))
    lines.append("  by unit (stations): " + ", ".join(
        f"{u}={n}" for u, n in sorted(Counter(r["unit"] for r in records if r["type"] in STATION_TYPES).items())))
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--refresh-bases", action="store_true", help="download the CAL FIRE layer and rewrite ca_fire_bases.json")
    parser.add_argument("--bases-from", type=Path, help="rebuild ca_fire_bases.json from a saved GeoJSON download")
    parser.add_argument("--retrieved", default=None, help="retrieval date (YYYY-MM-DD) recorded in the file")
    args = parser.parse_args(argv)
    if args.refresh_bases or args.bases_from:
        from datetime import date

        raw = args.bases_from.read_bytes() if args.bases_from else fetch_facilities_raw()
        built = build_bases(raw, args.retrieved or date.today().isoformat())
        BASES_PATH.write_text(json.dumps(built, indent=0, ensure_ascii=False) + "\n", encoding="utf-8")
        src = built["meta"]["source"]
        print(f"wrote {BASES_PATH} ({built['meta']['record_count']} records); raw {src['raw_bytes']} bytes sha256 {src['raw_sha256']}")
    resources, bases = load_resources(), load_bases()
    problems = validate_resources(resources) + validate_bases(bases)
    print(summary(resources, bases))
    for problem in problems:
        print("PROBLEM:", problem, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
