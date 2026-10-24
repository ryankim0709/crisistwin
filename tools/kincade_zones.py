"""Kincade evacuation zone polygons from the Sonoma County EOC ArcGIS layers.

The County EOC GIS account (org P5Mv5GY5S66M8Z1Q, portal socogis.sonoma-county.org)
published timestamped copies of the CAL FIRE incident zones during the fire.
These 2019 incident zones predate the County's later Zonehaven zone system
(adopted after 2019); they are not that system and are not backdated to it.

Each zone gets one primary polygon from the earliest layer in which its label
appears (precedence below). Every downloaded layer is kept raw, so later
revisions of the same label remain auditable.
"""

from __future__ import annotations

import re

from tools.kincade_common import SourceError, bbox_of, load_json, valid_lon_lat, walk_coords
from tools.kincade_events import zone_id

SERVICE_ROOT = "https://services1.arcgis.com/P5Mv5GY5S66M8Z1Q/arcgis/rest/services"
SOURCE_ID = "sonoma-eoc-arcgis-kincade-zones"
# (service name, label field, local snapshot label as stated by the item name/description, created_at UTC)
LAYERS = (
    ("Evac_Kincaid10_24", "Name", "2019-10-24 (item created 2019-10-24T14:41Z)"),
    ("Evacuation_Kincade_Fire", "Name", "item created 2019-10-24T16:16Z"),
    ("Evacuation_Kincade_Fire_1026_0600", None, "2019-10-26 06:00 (service name)"),
    ("Evacuation_Kincade_Fire_1026_1040_Type", "Name", "2019-10-26 10:40 (service name)"),
    ("Evacuation_Kincade_fire_1026_1530_Type", "Notes", "2019-10-26 15:30 (layer EvacArea_20191026_1530)"),
    ("Evacuation_Kincade_fire_1027_2000", "Notes", "layer Evac_Area_20191026_2000; item titled Kincade_Evac_Zones_20191027_2000"),
    ("Kincade_Branch_Zones_20191027_1218_View", "Notes", "2019-10-27 12:18; Napa County zones received 2019-10-28 22:27"),
    ("Kincade_Evacuation_Areas", "Notes", "2019-10-27 18:17 (layer Evac_Area_20191027_1817)"),
    ("Kincade_Evac_Zones_20191030_1300", "Notes", "as of 2019-10-30 13:00; revised 2019-11-01 12:50"),
    ("Kincade_Evac_Zones_20191101_1350", "Notes", "as of 2019-11-01 15:00; received from CAL FIRE 14:15"),
    ("Kincade_Evac_Zones_20191102_1500", "Notes", "as of 2019-11-02 15:00; received from CAL FIRE 13:30; revised 11/03, 11/04"),
    ("Zone31_Kincade_CALNU019376_View", "Name", "Lake County zones received 2019-10-28 22:27"),
)
LAYER_NAMES = tuple(name for name, _, _ in LAYERS)
# Primary geometry source per matrix label.
PRIMARY = {
    **{str(n): "Kincade_Evacuation_Areas" for n in range(1, 11)},
    "21": "Kincade_Branch_Zones_20191027_1218_View",
    "31": "Zone31_Kincade_CALNU019376_View",
    **{z: "Kincade_Evac_Zones_20191030_1300" for z in (
        "1A", "1B", "3A", "3B", "3C", "4A", "4B", "5A", "5B", "8A", "8B", "32", "33", "34", "6r", "Unnamed")},
    "1C": "Kincade_Evac_Zones_20191101_1350",
    **{z: "Kincade_Evac_Zones_20191102_1500" for z in ("1D", "3D", "5C")},
}
# Labels present only as County "Preplan" polygons (never listed in the matrix).
PREPLAN_LAYER = "Kincade_Evac_Zones_20191102_1500"
FOOTPRINTS = {
    "kincade-area-20191024": ("Evac_Kincaid10_24", "Evacuation Area October Kincaid Fire"),
    "kincade-area-20191026-0600": ("Evacuation_Kincade_Fire_1026_0600", None),
    "kincade-area-20191026-1040-mandatory": ("Evacuation_Kincade_Fire_1026_1040_Type", "Mandatory Evacuation"),
    "kincade-area-20191026-1040-warning": ("Evacuation_Kincade_Fire_1026_1040_Type", "Evacuation Warning"),
}


def _label(layer: str, props: dict) -> str | None:
    field = next(f for name, f, _ in LAYERS if name == layer)
    if field is None:
        return None
    value = props.get(field)
    if not isinstance(value, str):
        return None
    value = value.strip()
    match = re.fullmatch(r"(?:Zone )?([0-9]{1,2}[A-D]?)", value)
    if field == "Notes" and match:
        return match.group(1)
    if field == "Notes" and value == "" and props.get("EvacID") == "340":
        return "Unnamed"
    return value or None


def _check_polygon(geometry: dict, where: str) -> None:
    if not isinstance(geometry, dict) or geometry.get("type") not in ("Polygon", "MultiPolygon"):
        raise SourceError(f"{where}: geometry is not a polygon")
    points = list(walk_coords(geometry.get("coordinates")))
    if len(points) < 4 or not all(valid_lon_lat(p) for p in points):
        raise SourceError(f"{where}: invalid polygon coordinates")


def normalize_zones(layer_payloads: dict[str, bytes], place_subset: bytes | None = None) -> tuple[dict, dict]:
    if set(layer_payloads) != set(LAYER_NAMES):
        raise SourceError("zone layer set differs from the fixed layer list")
    by_layer: dict[str, list[tuple[str | None, dict]]] = {}
    for layer, payload in layer_payloads.items():
        data = load_json(payload, layer)
        if data.get("type") != "FeatureCollection" or not isinstance(data.get("features"), list):
            raise SourceError(f"{layer}: not a GeoJSON FeatureCollection")
        if data.get("exceededTransferLimit"):
            raise SourceError(f"{layer}: transfer limit exceeded")
        items = []
        for index, feature in enumerate(data["features"]):
            _check_polygon(feature.get("geometry"), f"{layer} feature {index}")
            items.append((_label(layer, feature.get("properties") or {}), feature))
        by_layer[layer] = items
    snapshot = {name: note for name, _, note in LAYERS}
    features = []

    def add(zid: str, label: str, kind: str, layer: str, feature: dict, matched: str) -> None:
        props = feature.get("properties") or {}
        revisions = sorted(l for l, items in by_layer.items() if l != layer and any(lab == matched for lab, _ in items))
        features.append({
            "type": "Feature", "id": zid, "geometry": feature["geometry"],
            "properties": {
                "zone_id": zid, "name": label if kind != "matrix_zone" else f"Zone {label}",
                "zone_label_as_written": "6 (original revised to remove City of Santa Rosa)" if label == "6r" else matched,
                "zone_kind": kind,
                "zone_system_version": f"CAL FIRE Kincade incident zones via Sonoma County EOC layer {layer} ({snapshot[layer]})",
                "zone_system_note": "2019 incident zones; not the later Sonoma County Zonehaven zones",
                "source_layer": layer,
                "source_object_id": props.get("OBJECTID_1", props.get("OBJECTID", props.get("FID", props.get("OID")))),
                "other_layers_with_same_label": revisions,
                "geometry_time_basis": "layer snapshot; the hosted layer may have been edited after its stated time",
                "evidence_class": "observed", "source_id": SOURCE_ID,
                "source_locator": f"{SERVICE_ROOT}/{layer}/FeatureServer/0",
            },
        })

    for label, layer in sorted(PRIMARY.items()):
        wanted = {"6r": "6", "Unnamed": "Unnamed"}.get(label, label)
        hits = [f for lab, f in by_layer[layer] if lab == wanted]
        if len(hits) != 1:
            raise SourceError(f"zone {label}: expected one polygon in {layer}, found {len(hits)}")
        add(zone_id(label), label, "matrix_zone", layer, hits[0], wanted)
    preplan = sorted(lab for lab, _ in by_layer[PREPLAN_LAYER] if lab and lab not in PRIMARY and lab != "6")
    for zid, (layer, wanted) in sorted(FOOTPRINTS.items()):
        hits = [f for lab, f in by_layer[layer] if lab == wanted]
        if len(hits) != 1:
            raise SourceError(f"{zid}: expected one polygon in {layer}, found {len(hits)}")
        add(zid, wanted or "Evacuation area 2019-10-26 06:00", "evacuation_area_footprint", layer, hits[0], wanted)
    if place_subset is not None:
        for place in load_json(place_subset, "TIGER place subset")["features"]:
            if place["properties"]["NAME"] != "Geyserville":
                continue
            _check_polygon(place["geometry"], "Geyserville CDP")
            features.append({"type": "Feature", "id": zone_id("geyserville-cdp"), "geometry": place["geometry"],
                             "properties": {
                                 "zone_id": zone_id("geyserville-cdp"), "name": place["properties"]["NAMELSAD"],
                                 "zone_label_as_written": "Community of Geyserville (Census Designated Area)",
                                 "zone_kind": "census_place_order_area",
                                 "zone_system_version": "US Census TIGER/Line 2018 place boundary (GEOID " + place["id"] + ")",
                                 "zone_system_note": "the Oct 23 order named the Census Designated Place; boundary from TIGER 2018",
                                 "source_layer": "tl_2018_06_place", "source_object_id": place["id"],
                                 "other_layers_with_same_label": [],
                                 "geometry_time_basis": "TIGER/Line 2018 vintage",
                                 "evidence_class": "observed", "source_id": "census-tiger-2018-place",
                                 "source_locator": "https://www2.census.gov/geo/tiger/TIGER2018/PLACE/tl_2018_06_place.zip",
                             }})
    features.sort(key=lambda f: f["id"])
    if len({f["id"] for f in features}) != len(features):
        raise SourceError("duplicate zone IDs")
    matrix = [f for f in features if f["properties"]["zone_kind"] == "matrix_zone"]
    quality = {
        "zone_count": len(features), "matrix_zone_count": len(matrix),
        "preplan_labels_not_packaged": preplan,
        "layer_feature_counts": {k: len(v) for k, v in sorted(by_layer.items())},
        "ordered_zones_1_10_bbox": bbox_of(p for f in matrix if f["properties"]["zone_label_as_written"] in [str(n) for n in range(1, 11)]
                                           for p in walk_coords(f["geometry"]["coordinates"])),
        "all_zone_bbox": bbox_of(p for f in features for p in walk_coords(f["geometry"]["coordinates"])),
        "limitations": [
            "County 'Preplan' polygons never listed in the order matrix are kept only in raw/ (labels in preplan_labels_not_packaged).",
            "Zone polygons come from County-hosted operational layers; their attributes (EvacStatus, dates, Population ranks) are not used because the hosted layers were edited after their stated times.",
            "Zone 6r and 'Unnamed' are the 10/30 revision of Zone 6 and its City of Santa Rosa carve-out (blank label, EvacID 340).",
            "Zones 1B, 1C, 3C and 5B were later reduced; the packaged polygon is the first one published for that label.",
            "The Oct 23 Geyserville order targets the Census Designated Place; its polygon is the TIGER 2018 CDP boundary.",
            "The County adopted Zonehaven evacuation zones after 2019; these are not those zones.",
        ],
    }
    return {"type": "FeatureCollection", "features": features}, quality
