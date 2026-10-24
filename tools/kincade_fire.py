"""Fire progression (FEDS), active-fire detections (FIRMS) and DINS damage points."""

from __future__ import annotations

import csv
import io
from datetime import datetime, timezone

from tools.kincade_common import (
    BBOX, INCIDENT_NUMBER, SourceError, bbox_of, load_json, local_to_utc, utc_text, valid_lon_lat, walk_coords,
)

FEDS_URL = "https://openveda.cloud/api/features/collections/public.eis_fire_lf_perimeter_archive/items"
FEDS_FIRE_ID = "F15031"  # discovered by bbox + 2019-10-23/11-10 datetime query; single fire in the box
FEDS_QUERY = {"filter": f"fireid = '{FEDS_FIRE_ID}'", "datetime": "2019-10-23T00:00:00Z/2019-11-30T00:00:00Z", "limit": "200"}
FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov/data/country"
FIRMS_FILES = {
    "modis": "modis/2019/modis_2019_United_States.csv",
    "viirs-snpp": "viirs-snpp/2019/viirs-snpp_2019_United_States.csv",
}
FIRMS_DATES = ("2019-10-23", "2019-11-07")  # acquisition dates (UTC), inclusive
DINS_URL = "https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/arcgis/rest/services/POSTFIRE_MASTER_DATA_SHARE/FeatureServer/0"
DINS_FIELDS = ("OBJECTID", "GLOBALID", "DAMAGE", "INCIDENTNAME", "INCIDENTNUM", "INCIDENTSTARTDATE", "STRUCTURECATEGORY")


def normalize_feds(payload: bytes) -> tuple[dict, dict]:
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
        if geometry.get("type") not in ("Polygon", "MultiPolygon") or not all(
                valid_lon_lat(p) for p in walk_coords(geometry.get("coordinates"))):
            raise SourceError(f"FEDS {local}: invalid polygon")
        clock = datetime.fromisoformat(local)
        if clock.minute or clock.second or clock.hour not in (0, 12):
            raise SourceError(f"FEDS {local}: not a noon/midnight snapshot")
        at = utc_text(local_to_utc(clock))
        out.append({"type": "Feature", "id": f"feds-veda:{FEDS_FIRE_ID}:{local}", "geometry": geometry,
                    "properties": {
                        "snapshot_local_time": local, "snapshot_at": at,
                        "arrival_from": None, "arrival_to": at,
                        "time_precision": "half_day",
                        "time_basis": "FEDS t is local time corrected to the nearest noon/midnight; converted as America/Los_Angeles (derived)",
                        "area_km2": props.get("farea"), "farea_km2": props.get("farea"), "fperim_km": props.get("fperim"),
                        "duration_days": props.get("duration"), "meanfrp": props.get("meanfrp"),
                        "n_pixels": props.get("n_pixels"), "n_newpixels": props.get("n_newpixels"),
                        "method": "FEDS satellite-derived (VIIRS) cumulative perimeter",
                        "evidence_class": "derived", "source_id": "feds-veda-archive",
                        "source_locator": f"{FEDS_URL}?filter=fireid = '{FEDS_FIRE_ID}' feature t={local}",
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
               "note": "FEDS starts 2019-10-24 00:00 local (07:00Z), about 2.5 h after ignition; no NIST-style reconstruction exists for Kincade."}
    return {"type": "FeatureCollection", "features": out}, quality


def firms_subset(full_csv: bytes) -> bytes:
    """Deterministic bbox + date subset of a FIRMS yearly country CSV (header kept)."""
    text = full_csv.decode("utf-8")
    reader = csv.reader(io.StringIO(text))
    header = next(reader)
    lat_i, lon_i, date_i = header.index("latitude"), header.index("longitude"), header.index("acq_date")
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(header)
    west, south, east, north = BBOX
    for row in reader:
        lon, lat = float(row[lon_i]), float(row[lat_i])
        if west <= lon <= east and south <= lat <= north and FIRMS_DATES[0] <= row[date_i] <= FIRMS_DATES[1]:
            writer.writerow(row)
    return out.getvalue().encode()


def normalize_firms(subsets: dict[str, bytes]) -> tuple[dict, dict]:
    features = []
    counts = {}
    for product, payload in sorted(subsets.items()):
        reader = csv.DictReader(io.StringIO(payload.decode("utf-8")))
        n = 0
        for index, row in enumerate(reader, 2):
            lon, lat = float(row["longitude"]), float(row["latitude"])
            stamp = datetime.strptime(row["acq_date"] + row["acq_time"].zfill(4), "%Y-%m-%d%H%M").replace(tzinfo=timezone.utc)
            bright = row.get("brightness") or row.get("bright_ti4")
            features.append({"type": "Feature", "id": f"firms:{product}:{index}",
                             "geometry": {"type": "Point", "coordinates": [lon, lat]},
                             "properties": {
                                 "acquired_at": utc_text(stamp), "time_precision": "minute",
                                 "product": product, "satellite": row["satellite"], "instrument": row["instrument"],
                                 "confidence": row["confidence"], "frp_mw": float(row["frp"]),
                                 "brightness_k": float(bright), "daynight": row["daynight"],
                                 "scan": float(row["scan"]), "track": float(row["track"]),
                                 "version": row["version"], "type": row.get("type"),
                                 "evidence_class": "observed", "source_id": f"nasa-firms-{product}-2019",
                                 "source_locator": f"subset row {index}",
                             }})
            n += 1
        counts[product] = n
    features.sort(key=lambda f: (f["properties"]["acquired_at"], f["id"]))
    return {"type": "FeatureCollection", "features": features,
            "pixel_note": "points are pixel centres; footprint ~375 m (VIIRS) or ~1 km (MODIS) at nadir",
            "source_files": {k: f"{FIRMS_BASE}/{v}" for k, v in FIRMS_FILES.items()}}, {
        "detection_counts": counts, "date_range_utc": list(FIRMS_DATES),
        "note": "All detections in the package bbox and dates are kept; not every detection belongs to the Kincade Fire.",
    }


def normalize_dins(payload: bytes) -> tuple[dict, dict]:
    data = load_json(payload, "DINS response")
    if data.get("error") or data.get("exceededTransferLimit") or (data.get("spatialReference") or {}).get("wkid") != 4326:
        raise SourceError("DINS response invalid, truncated or not WGS84")
    features, damage = [], {}
    for feature in data.get("features", []):
        a, g = feature.get("attributes") or {}, feature.get("geometry") or {}
        if set(a) != set(DINS_FIELDS):
            raise SourceError("DINS response has unexpected fields (address/parcel fields must not be requested)")
        if a["INCIDENTNAME"] != "Kincade" or a["INCIDENTNUM"] != INCIDENT_NUMBER:
            raise SourceError("DINS feature from another incident")
        coord = [g.get("x"), g.get("y")]
        if not valid_lon_lat(coord):
            raise SourceError("DINS feature with invalid point")
        damage[a["DAMAGE"]] = damage.get(a["DAMAGE"], 0) + 1
        features.append({"type": "Feature", "id": f"calfire-dins:{a['GLOBALID'].lower()}",
                         "geometry": {"type": "Point", "coordinates": coord},
                         "properties": {"damage": a["DAMAGE"], "structure_category": a["STRUCTURECATEGORY"],
                                        "incident_number": a["INCIDENTNUM"],
                                        "incident_start_date": datetime.fromtimestamp(a["INCIDENTSTARTDATE"] / 1000, timezone.utc).date().isoformat(),
                                        "assessment_at": None, "temporal_role": "post_event",
                                        "location_role": "structure inspection point",
                                        "evidence_class": "observed", "source_id": "calfire-dins",
                                        "source_locator": f"{DINS_URL} OBJECTID {a['OBJECTID']}"}})
    features.sort(key=lambda f: f["id"])
    return {"type": "FeatureCollection", "features": features}, {
        "record_count": len(features), "damage_counts": dict(sorted(damage.items())),
        "bbox": bbox_of(f["geometry"]["coordinates"] for f in features),
        "privacy": "address, parcel, owner-value and structure-detail fields are not requested or stored",
    }
