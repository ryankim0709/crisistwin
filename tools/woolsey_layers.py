"""Woolsey package v2 layers: evacuation zones, zone-targeted orders, the zone x block-group
crosswalk, FEDS perimeters in the shared (Kincade) schema, and CAL FIRE DINS damage points.

Zone sources (see tools/woolsey_zones_table.json):
- Ventura County OES public incident web map d2bcf58547864afd81a78f834608a8f9, whose item data
  JSON the Wayback Machine archived four times (2018-11-09..13). Its evacuation layers are
  inline feature collections in Web Mercator; the package keeps a derived subset without the
  GIS staff names that the full captures hold (``webmap_subsets``).
- TIGER/Line 2018 place polygons for cities an order named whole.
- Order areas whose boundary is not unambiguous get geometry null and a reason.

Stdlib only; everything here is offline.
"""

from __future__ import annotations

import io
import json
import math
import zipfile
from datetime import datetime, timedelta, timezone

from tools.build_camp_evacuation import SourceError, encoded_json, sha256
from tools.kincade_common import bbox_of, valid_lon_lat, walk_coords
from tools import kincade_population

PST = timezone(timedelta(hours=-8), "PST")  # DST ended 2018-11-04; the whole incident is PST
WEBMAP_ITEM = "d2bcf58547864afd81a78f834608a8f9"
WEBMAP_URL = f"https://vcoes.maps.arcgis.com/sharing/rest/content/items/{WEBMAP_ITEM}/data?f=json"
VCEMERGENCY_URL = "https://www.vcemergency.com/"
WAYBACK = "https://web.archive.org/web/{ts}id_/{url}"
MERCATOR_R_M = 6378137.0
# Feature attributes kept in the subset; the rest are empty, or name GIS staff (incidentna, created_us, modify_use).
WEBMAP_KEEP_ATTRS = ("FID", "condition", "created_da", "featuretyp", "groupname", "modify_dat", "objectid")
PLACE_URL = "https://www2.census.gov/geo/tiger/TIGER2018/PLACE/tl_2018_06_place.zip"
PLACE_FIELDS = ("GEOID", "NAME", "NAMELSAD", "LSAD", "CLASSFP", "ALAND", "AWATER")
FEDS_URL = "https://openveda.cloud/api/features/collections/public.eis_fire_lf_perimeter_archive/items"
FEDS_FIRE_ID = "F17192"
FEDS_DATETIME = "2018-11-01T00:00:00Z/2018-12-01T00:00:00Z"
DINS_URL = "https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/arcgis/rest/services/POSTFIRE_MASTER_DATA_SHARE/FeatureServer/0"
DINS_FIELDS = ("OBJECTID", "GLOBALID", "DAMAGE", "INCIDENTNAME", "INCIDENTNUM", "INCIDENTSTARTDATE", "STRUCTURECATEGORY")
DINS_WHERE = "INCIDENTNAME='Woolsey'"
DINS_INCIDENT_NUMBER = "CALAC 33891"
DINS_PAGE_SIZE = 2000
DINS_OFFSETS = (0, 2000)
NOTICE_TYPES = ("evacuation_order", "evacuation_warning")


def utc_text(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def load_json(data: bytes, label: str):
    try:
        return json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SourceError(f"{label}: invalid JSON: {exc}") from exc


def pst(text: str) -> datetime:
    return datetime.fromisoformat(text).replace(tzinfo=PST)


def capture_time(ts: str) -> datetime:
    return datetime.strptime(ts, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)


def wayback(ts: str, url: str) -> str:
    return WAYBACK.format(ts=ts, url=url)


# --------------------------------------------------------------------------- subsets (run once on full downloads)
def _is_evacuation_layer(title: str) -> bool:
    return "Evacuation" in title or title in ("101-South-woosley", "SouthCoastEOC")


def webmap_subset(full: bytes, ts: str) -> dict:
    """Evacuation layers of one archived web-map capture: title, visibility, kept attributes, rings (EPSG:3857)."""
    data = load_json(full, f"web map capture {ts}")
    if not isinstance(data.get("operationalLayers"), list):
        raise SourceError(f"web map capture {ts} has no operational layers")
    layers = []
    for layer in data["operationalLayers"]:
        title = layer.get("title") or ""
        collection = layer.get("featureCollection")
        if not collection or not _is_evacuation_layer(title):
            continue
        features = []
        for sub in collection.get("layers", []):
            for feature in sub.get("featureSet", {}).get("features", []):
                geometry = feature.get("geometry") or {}
                if (geometry.get("spatialReference") or {}).get("wkid") not in (102100, 3857):
                    raise SourceError(f"{ts} {title}: geometry is not Web Mercator")
                attrs = feature.get("attributes") or {}
                features.append({"attributes": {k: attrs[k] for k in WEBMAP_KEEP_ATTRS if k in attrs},
                                 "rings": geometry["rings"]})
        layers.append({"title": title, "visibility": layer.get("visibility"), "features": features})
    return {"wayback_timestamp": ts, "url": wayback(ts, WEBMAP_URL), "full_bytes": len(full),
            "full_sha256": sha256(full), "layers": layers}


def extract_webmaps(captures: dict[str, bytes]) -> bytes:
    return encoded_json({
        "source_url": WEBMAP_URL,
        "extraction": ("derived: for each Wayback capture of the web map item data, the operational layers whose "
                       "title contains 'Evacuation' (plus '101-South-woosley' and 'SouthCoastEOC'): title, "
                       f"visibility, attributes {list(WEBMAP_KEEP_ATTRS)}, and polygon rings exactly as given "
                       "(Web Mercator metres). Staff-name attributes and all other layers are dropped."),
        "captures": {ts: webmap_subset(data, ts) for ts, data in sorted(captures.items())}})


def extract_places(place_zip: bytes, geoids: list[str]) -> bytes:
    archive = zipfile.ZipFile(io.BytesIO(place_zip))
    shapes = kincade_population.read_shp_polygons(archive.read("tl_2018_06_place.shp"))
    rows = kincade_population.read_dbf(archive.read("tl_2018_06_place.dbf"))
    if len(shapes) != len(rows):
        raise SourceError("TIGER place shp/dbf record counts differ")
    features = [{"type": "Feature", "id": row["GEOID"], "geometry": geometry,
                 "properties": {k: row[k] for k in PLACE_FIELDS}}
                for geometry, row in zip(shapes, rows) if row["GEOID"] in geoids and geometry]
    if sorted(f["id"] for f in features) != sorted(geoids):
        raise SourceError("TIGER place subset did not find every listed GEOID exactly once")
    features.sort(key=lambda f: f["id"])
    return encoded_json({"type": "FeatureCollection", "features": features,
                         "extraction": f"derived: TIGER 2018 CA places with GEOID in {sorted(geoids)}; rings re-oriented to RFC 7946"})


# --------------------------------------------------------------------------- zones
def mercator_to_lon_lat(x: float, y: float) -> list[float]:
    lon = math.degrees(x / MERCATOR_R_M)
    lat = math.degrees(2 * math.atan(math.exp(y / MERCATOR_R_M)) - math.pi / 2)
    return [round(lon, 7), round(lat, 7)]


def _ring_area2(ring: list[list[float]]) -> float:
    return sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:]))


def webmap_polygon(rings: list) -> dict:
    """One exterior ring (Esri clockwise) -> RFC 7946 Polygon (counter-clockwise exterior)."""
    if len(rings) != 1:
        raise SourceError("web map evacuation polygons are expected to have exactly one ring")
    ring = [mercator_to_lon_lat(p[0], p[1]) for p in rings[0]]
    if ring[0] != ring[-1] or len(ring) < 4:
        raise SourceError("web map ring is not closed")
    if _ring_area2(ring) < 0:
        ring = ring[::-1]
    return {"type": "Polygon", "coordinates": [ring]}


def _check_polygon(geometry: dict, where: str) -> None:
    if not isinstance(geometry, dict) or geometry.get("type") not in ("Polygon", "MultiPolygon"):
        raise SourceError(f"{where}: geometry is not a polygon")
    points = list(walk_coords(geometry.get("coordinates")))
    if len(points) < 4 or not all(valid_lon_lat(p) for p in points):
        raise SourceError(f"{where}: invalid polygon coordinates")


def _citygate_locator(citygate: dict, printed_page: int, where: str) -> str:
    return f"{citygate['source_url']}#page={printed_page + citygate['pdf_page_offset']}; {where}; p. {printed_page}"


def normalize_zones(table: dict, webmaps: bytes, places: bytes, citygate: dict) -> tuple[dict, dict]:
    captures = load_json(webmaps, "web map subsets")["captures"]
    if sorted(captures) != sorted(table["webmap_captures"]):
        raise SourceError("web map captures differ from the curated capture list")
    place_by_id = {f["id"]: f for f in load_json(places, "TIGER place subset")["features"]}
    features = []
    for zone in table["zones"]:
        zid, source = zone["zone_id"], zone["geometry_source"]
        props = {"zone_id": zid, "name": zone["name"], "zone_label_as_written": zone["zone_label_as_written"],
                 "fire_name": zone["fire_name"], "county": zone["county"], "other_layers_with_same_label": [],
                 "notes": zone.get("notes")}
        geometry = None
        if source and source["kind"] == "webmap_layer":
            seen, revisions = [], []
            for ts in sorted(captures):
                layer = next((l for l in captures[ts]["layers"] if l["title"] in source["layer_titles"]), None)
                hit = [f for f in (layer or {}).get("features", []) if f["attributes"].get("FID") == source["fid"]]
                if len(hit) > 1:
                    raise SourceError(f"{zid}: several features with FID {source['fid']} in capture {ts}")
                on_map = bool(hit)
                seen.append({"captured_at": utc_text(capture_time(ts)), "wayback_timestamp": ts, "on_map": on_map,
                             "layer_title": layer["title"] if layer else None,
                             "layer_visible": layer["visibility"] if layer else None})
                if on_map:
                    shape = webmap_polygon(hit[0]["rings"])
                    if geometry is None:
                        geometry, first, attrs, title = shape, ts, hit[0]["attributes"], layer["title"]
                    elif shape != geometry:
                        revisions.append(ts)
            if geometry is None:
                raise SourceError(f"{zid}: layer {source['layer_titles']} FID {source['fid']} absent from every capture")
            present = [s["captured_at"] for s in seen if s["on_map"]]
            props.update({
                "zone_kind": "official_map_layer",
                "zone_system_version": f"Ventura County OES public incident web map {WEBMAP_ITEM} (Woolsey/Hill Fires, Nov 2018)",
                "zone_system_note": "ad hoc incident evacuation areas; LA and Ventura Counties had no pre-defined zones in 2018",
                "source_layer": title, "source_object_id": source["fid"],
                "source_feature_attributes": attrs, "status_on_map": zone["status_on_map"],
                "map_captures": seen, "first_seen_on_map_at": present[0], "last_seen_on_map_at": present[-1],
                "geometry_revised_in_captures": revisions,
                "geometry_time_basis": f"on the official map in the Wayback capture of {present[0]}; drawn at or before",
                "geometry_status": "observed", "geometry_reason": None, "geometry_method":
                    "Web Mercator rings converted to longitude/latitude (spherical inverse, 7 decimals; derived)",
                "evidence_class": "observed", "source_id": "vcoes-webmap-wayback",
                "source_locator": f"{wayback(first, WEBMAP_URL)} operationalLayers title '{title}' FID {source['fid']}"})
        elif source and source["kind"] == "tiger_place":
            place = place_by_id.get(source["geoid"])
            if place is None:
                raise SourceError(f"{zid}: TIGER place {source['geoid']} not in the subset")
            geometry = place["geometry"]
            props.update({
                "zone_kind": "census_place_order_area",
                "zone_system_version": f"US Census TIGER/Line 2018 place boundary (GEOID {place['id']}, {place['properties']['NAMELSAD']})",
                "zone_system_note": "the order named this city whole; boundary from TIGER/Line 2018 (legal boundaries as of 2018-01-01)",
                "source_layer": "tl_2018_06_place", "source_object_id": place["id"],
                "geometry_time_basis": "TIGER/Line 2018 vintage",
                "geometry_status": "reconstructed", "geometry_reason": None,
                "evidence_class": "reconstructed", "source_id": "census-tiger-2018-place / citygate-aar-2019",
                "source_locator": f"order: {zone['order_source_locator']}; geometry: {PLACE_URL} GEOID {place['id']}"})
        else:
            if zone["source"] == "citygate":
                locator = _citygate_locator(citygate, zone["source_locator_page"], "area as named")
                source_id, evidence = "citygate-aar-2019", "reconstructed"
            else:
                locator = f"{wayback('20181112235749', VCEMERGENCY_URL)} Woolsey mandatory evacuation list"
                source_id, evidence = "vcemergency-wayback", "observed"
            props.update({
                "zone_kind": "described_area", "zone_system_version": "order text only (no published boundary)",
                "zone_system_note": "named in an order or warning; boundary not unambiguous from public geometry",
                "source_layer": None, "source_object_id": None, "geometry_time_basis": None,
                "geometry_status": "unknown", "geometry_reason": zone["geometry_reason"],
                "evidence_class": evidence, "source_id": source_id, "source_locator": locator})
        if geometry is not None:
            _check_polygon(geometry, zid)
        features.append({"type": "Feature", "id": zid, "geometry": geometry, "properties": props})
    features.sort(key=lambda f: f["id"])
    if len({f["id"] for f in features}) != len(features):
        raise SourceError("duplicate zone IDs")
    with_geometry = [f for f in features if f["geometry"]]
    kinds: dict[str, int] = {}
    for f in features:
        kinds[f["properties"]["zone_kind"]] = kinds.get(f["properties"]["zone_kind"], 0) + 1
    quality = {
        "zone_count": len(features), "with_geometry": len(with_geometry),
        "without_geometry": len(features) - len(with_geometry), "by_kind": dict(sorted(kinds.items())),
        "hill_fire_zones": sorted(f["id"] for f in features if f["properties"]["fire_name"] == "Hill"),
        "bbox_with_geometry": bbox_of(p for f in with_geometry for p in walk_coords(f["geometry"]["coordinates"])),
        "limitations": [
            "Ventura polygons are what the County's public map showed at each Wayback capture; their issue times are not on the map.",
            "No LA County order polygons were found (no archived LA County / City of Malibu evacuation map); LA areas are TIGER cities named whole or null-geometry described areas.",
            "Hill Fire zones are kept as map context (fire_name 'Hill') with no order events.",
            "Zones overlap (for example Bell Canyon and Saddlebow); the crosswalk lists each zone separately.",
        ],
    }
    return {"type": "FeatureCollection", "features": features}, quality


# --------------------------------------------------------------------------- orders
def zone_order_events(table: dict, citygate: dict) -> list[dict]:
    pages = table["sources"]["vcemergency-wayback"]["captures"]
    events = []
    for row in table["orders"]:
        source_id = row["source_id"]
        kind = "Evacuation order" if row["type"] == "evacuation_order" else "Evacuation warning"
        base = {"event_id": row["event_id"], "type": row["type"],
                "target": {"place_name": row["place_name"], "zone_ids": row["zone_ids"],
                           "zone_mapping_basis": "curated/zones.json order row"},
                "geometry": None, "geocode_method": "zone_id_lookup",
                "description": f"{kind}: {row['place_name']}", "quote": row["quote"],
                "evidence_class": row["evidence_class"], "source_id": source_id}
        if source_id in ("vcemergency-wayback", "vcoes-webmap-wayback"):
            captured = capture_time(row["capture"])
            if row.get("as_of_local"):
                latest = pst(row["as_of_local"])
                header = pages[row["capture"]]["as_of_as_written"]
                role = f"listed as in effect on the official page headed '{header}'; issued at or before"
                written = f"page header: {header}"
            else:
                latest = captured
                what = "page" if source_id == "vcemergency-wayback" else "map"
                role = f"listed as in effect on the official {what} in the Wayback capture; issued at or before the capture"
                written = f"Wayback capture {row['capture']} (UTC)"
            window = "unknown: the order may predate its first archived listing"
            if row.get("previous_capture_without"):
                window += f"; not listed in the previous capture {utc_text(capture_time(row['previous_capture_without']))}"
            url = VCEMERGENCY_URL if source_id == "vcemergency-wayback" else WEBMAP_URL
            where = "Woolsey Fire evacuation list" if source_id == "vcemergency-wayback" else f"operationalLayers title '{row['quote']}'"
            base.update({
                "occurred_at": utc_text(latest), "occurred_from": None, "occurred_to": utc_text(latest),
                "time_precision": "approximate", "occurred_window_status": window,
                "time_role": role + "; occurred_at is the latest bound",
                "available_at": utc_text(captured),
                "available_at_status": "public on the official page/map at the Wayback capture time (latest bound)",
                "local_time_as_written": written,
                "source_locator": f"{wayback(row['capture'], url)}; {where}"})
        elif source_id == "citygate-aar-2019":
            sent = pst(row["sent_local"])
            locator = _citygate_locator(citygate, row["printed_page"], f"Section 3 timeline, Significant Event {row['se']}")
            if row.get("stated_local"):
                at = pst(row["stated_local"])
                base.update({"occurred_at": utc_text(at), "occurred_from": utc_text(at), "occurred_to": utc_text(at),
                             "local_time_as_written": f"{row['stated_local'][:10]} {row['stated_local'][11:]} (stated in the message)"})
            else:
                base.update({"occurred_at": utc_text(sent), "occurred_from": None, "occurred_to": utc_text(sent),
                             "occurred_window_status": "unknown: the order was in place at or before the message time",
                             "local_time_as_written": f"{row['sent_local'][:10]} {row['sent_local'][11:]}"})
            base.update({"time_precision": "minute", "time_role": row["time_role"],
                         "available_at": utc_text(sent), "available_at_status": "public message send time",
                         "derived_from_event_id": row["derived_from_event_id"], "source_locator": locator})
        else:
            raise SourceError(f"{row['event_id']}: unknown source {source_id}")
        if len(row["quote"].split()) > 25:
            raise SourceError(f"{row['event_id']}: quote exceeds 25 words")
        events.append(base)
    return events


def apply_zone_ids(events: list[dict], table: dict, zone_ids: set[str]) -> list[dict]:
    """Add curated zone IDs to existing events; every order/warning zone ID must exist in the zones layer."""
    mapping = table["event_zone_ids"]
    by_id = {e["event_id"]: e for e in events}
    missing = sorted(set(mapping) - set(by_id))
    if missing:
        raise SourceError(f"zone mapping names unknown events: {missing}")
    out = []
    for event in events:
        if event["event_id"] in mapping:
            row = mapping[event["event_id"]]
            previous = event["target"].get("zone_ids")
            event = {**event, "target": {**event["target"], "zone_ids": row["zone_ids"],
                                         **({"zone_labels_as_written": previous} if previous else {}),
                                         "zone_mapping_basis": row["basis"]},
                     "geocode_method": "zone_id_lookup"}
        ids = (event.get("target") or {}).get("zone_ids") or []
        unknown = [z for z in ids if z not in zone_ids]
        if unknown:
            raise SourceError(f"{event['event_id']}: zone IDs not in the zones layer: {unknown}")
        out.append(event)
    return out


# --------------------------------------------------------------------------- crosswalk
def zone_crosswalk(population: dict, zones: dict) -> dict:
    """Kincade lattice crosswalk (tools.kincade_population.zone_crosswalk) over every zone with a polygon."""
    view = {"features": [{**f, "properties": {**f["properties"], "zone_kind": "matrix_zone"}}
                         for f in zones["features"] if f["geometry"]]}
    out = kincade_population.zone_crosswalk(population, view)
    out["zone_kind"] = "every zone with geometry (official_map_layer, census_place_order_area)"
    out["helper"] = "tools.kincade_population.zone_crosswalk (lattice method shared with the Kincade package)"
    out["population_source"] = "normalized/population_units.geojson (ACS 2013-2017 5-year block groups)"
    out["zones_without_geometry"] = sorted(f["id"] for f in zones["features"] if not f["geometry"])
    return out


# --------------------------------------------------------------------------- fire perimeters (shared schema)
def normalize_perimeters(payload: bytes) -> tuple[dict, dict]:
    data = load_json(payload, "FEDS response")
    features = data.get("features")
    if not isinstance(features, list) or data.get("numberMatched") != len(features) or not features:
        raise SourceError("FEDS response missing, empty or truncated")
    out, seen = [], set()
    for feature in features:
        props = feature.get("properties") or {}
        local = props.get("t")
        if props.get("fireid") != FEDS_FIRE_ID or not isinstance(local, str) or local in seen:
            raise SourceError("FEDS feature has wrong fire ID or duplicate time")
        seen.add(local)
        geometry = feature.get("geometry") or {}
        _check_polygon(geometry, f"FEDS {local}")
        clock = datetime.fromisoformat(local)
        if clock.minute or clock.second or clock.hour not in (0, 12) or not datetime(2018, 11, 5) <= clock < datetime(2019, 3, 10):
            raise SourceError(f"FEDS {local}: not a noon/midnight PST snapshot")
        at = utc_text(clock.replace(tzinfo=PST))
        out.append({"type": "Feature", "id": f"feds-veda:{FEDS_FIRE_ID}:{local}", "geometry": geometry,
                    "properties": {
                        "snapshot_local_time": local, "snapshot_at": at, "arrival_from": None, "arrival_to": at,
                        "time_precision": "half_day",
                        "time_basis": "FEDS t is local time corrected to the nearest noon/midnight; converted as PST (UTC-8) (derived)",
                        "area_km2": props.get("farea"), "farea_km2": props.get("farea"), "fperim_km": props.get("fperim"),
                        "duration_days": props.get("duration"), "meanfrp": props.get("meanfrp"),
                        "n_pixels": props.get("n_pixels"), "n_newpixels": props.get("n_newpixels"),
                        "feds_fireid": FEDS_FIRE_ID, "feds_ogc_fid": props.get("ogc_fid"),
                        "method": "FEDS satellite-derived (VIIRS) cumulative perimeter",
                        "evidence_class": "derived", "source_id": "nasa-veda-feds",
                        "source_locator": f"{FEDS_URL}?filter=fireid = '{FEDS_FIRE_ID}'&datetime={FEDS_DATETIME} feature t={local}; raw/feds-F17192.json",
                    }})
    out.sort(key=lambda f: f["properties"]["snapshot_at"])
    for prev, cur in zip(out, out[1:]):
        cur["properties"]["arrival_from"] = prev["properties"]["snapshot_at"]
    times = [datetime.fromisoformat(f["properties"]["snapshot_at"].replace("Z", "+00:00")) for f in out]
    quality = {"perimeter_count": len(out), "first": out[0]["properties"]["snapshot_at"],
               "last": out[-1]["properties"]["snapshot_at"],
               "max_gap_hours": max((b - a).total_seconds() / 3600 for a, b in zip(times, times[1:])),
               "final_farea_km2": out[-1]["properties"]["farea_km2"],
               "bbox": bbox_of(p for f in out for p in walk_coords(f["geometry"]["coordinates"])),
               "note": ("Same FEDS F17192 features as normalized/fire_perimeters_feds.geojson, in the Kincade schema. "
                        "That legacy file labels them 'reconstructed'; this one follows Kincade ('derived'). "
                        "First snapshot 2018-11-09T08:00Z, about 9.6 h after the first report.")}
    return {"type": "FeatureCollection", "features": out}, quality


# --------------------------------------------------------------------------- DINS
def normalize_dins(pages: list[bytes], expected_total: int) -> tuple[dict, dict]:
    features, damage, ids = [], {}, set()
    for index, payload in enumerate(pages):
        data = load_json(payload, f"DINS page {index}")
        if data.get("error") or (data.get("spatialReference") or {}).get("wkid") != 4326:
            raise SourceError(f"DINS page {index} invalid or not WGS84")
        if bool(data.get("exceededTransferLimit")) != (index < len(pages) - 1):
            raise SourceError(f"DINS page {index}: transfer-limit flag inconsistent with paging")
        for feature in data.get("features", []):
            a, g = feature.get("attributes") or {}, feature.get("geometry") or {}
            if set(a) != set(DINS_FIELDS):
                raise SourceError("DINS response has unexpected fields (address/parcel fields must not be requested)")
            if a["INCIDENTNAME"] != "Woolsey" or a["INCIDENTNUM"] != DINS_INCIDENT_NUMBER:
                raise SourceError("DINS feature from another incident")
            coord = [g.get("x"), g.get("y")]
            if not valid_lon_lat(coord):
                raise SourceError("DINS feature with invalid point")
            fid = f"calfire-dins:{a['GLOBALID'].lower()}"
            if fid in ids:
                raise SourceError(f"duplicate DINS record {fid}")
            ids.add(fid)
            damage[a["DAMAGE"]] = damage.get(a["DAMAGE"], 0) + 1
            features.append({"type": "Feature", "id": fid, "geometry": {"type": "Point", "coordinates": coord},
                             "properties": {"damage": a["DAMAGE"], "structure_category": a["STRUCTURECATEGORY"],
                                            "incident_number": a["INCIDENTNUM"],
                                            "incident_start_date": datetime.fromtimestamp(a["INCIDENTSTARTDATE"] / 1000, timezone.utc).date().isoformat(),
                                            "assessment_at": None, "temporal_role": "post_event",
                                            "location_role": "structure inspection point",
                                            "evidence_class": "observed", "source_id": "calfire-dins",
                                            "source_locator": f"{DINS_URL} OBJECTID {a['OBJECTID']}"}})
    if len(features) != expected_total:
        raise SourceError(f"DINS pages hold {len(features)} records; the statistics query counted {expected_total}")
    features.sort(key=lambda f: f["id"])
    return {"type": "FeatureCollection", "features": features}, {
        "record_count": len(features), "damage_counts": dict(sorted(damage.items())),
        "bbox": bbox_of(f["geometry"]["coordinates"] for f in features),
        "privacy": "address, parcel (APN), owner-value and structure-detail fields are not requested or stored",
        "note": "assessment dates are not in the requested fields; points are post-event inspections"}


def notice_zone_check(events: list[dict], zones: dict) -> dict:
    with_geometry = {f["id"] for f in zones["features"] if f["geometry"]}
    notices = [e for e in events if e["type"] in NOTICE_TYPES]
    zoned = [e for e in notices if (e.get("target") or {}).get("zone_ids")]
    return {"orders_and_warnings": len(notices), "with_zone_ids": len(zoned),
            "with_a_polygon_zone": sum(1 for e in zoned if set(e["target"]["zone_ids"]) & with_geometry),
            "without_zone_ids": sorted(e["event_id"] for e in notices if e not in zoned)}
