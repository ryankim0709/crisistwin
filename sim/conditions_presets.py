"""Region-specific date presets for world conditions (`GET /api/conditions/presets`).

Pure data plus small lookups; no network. Each region of the `/fire` catalogue
(`app/src/fire/regions.ts`, ids and centres copied here) and each historical fire gets:

* ``phenology_class``: which ASSUMED live-fuel calendar of ``sim/fuel_moisture.py`` applies.
* ``typical_season_date``: an ASSUMED month-day in that region's peak fire season. California
  regions use the offshore-wind (Diablo / Santa Ana / north-east foehn) season when cured fuels and
  dry offshore wind coincide; it is a planning default, not a statistic computed here.
* presets: a 95th and a 50th percentile climatology day at that date (evidence ``derived`` once
  run, by ``sim.weather.climatology_percentile``), and for the historical fires a
  ``historical_replay`` of the real ignition window (evidence ``observed`` once run). Ignition times
  and points carry the source they were taken from in this repository.
"""

from __future__ import annotations

import math

# Offshore sector of sim.weather (north-northwest through east) and the Front Range downslope sector.
OFFSHORE_SECTOR_DEG = (315.0, 90.0)  # sim/weather.py scenario_wind default
# Assumption: Front Range downslope windstorms (e.g. the Marshall Fire day) blow from the west;
# W +/- 45 degrees. Not derived from data here.
FRONT_RANGE_DOWNSLOPE_SECTOR_DEG = (225.0, 315.0)

# Assumed peak-season month-day per region group (see module docstring).
TYPICAL_SEASON_DATE = {
    "San Francisco Bay Area": "10-15",
    "Central Coast": "10-15",
    "Central Sierra & Kern": "09-15",
    "Southern California": "11-01",
    "montane": "10-25",
}
CLIMATOLOGY_PRESET_YEAR = 2025  # label year only: the climatology pools 2012-2025 for the month
CLIMATOLOGY_PRESET_HOUR_UTC = 20  # about noon Pacific standard time; the analog is relabelled to it
CLIMATOLOGY_PRESET_HOURS = 24

MONTANE_REGIONS = {"lake-arrowhead", "big-bear-valley", "idyllwild-pine-cove"}

# (id, name, area, lat, lon) from app/src/fire/regions.ts CALIFORNIA_REGIONS (centre).
CATALOGUE_REGIONS = (
    ("oakland-montclair-redwood", "Montclair & Redwood Regional", "San Francisco Bay Area", 37.82, -122.195),
    ("berkeley-hills-tilden", "Berkeley Hills & Tilden", "San Francisco Bay Area", 37.895, -122.23),
    ("moraga-las-trampas", "Moraga & Las Trampas", "San Francisco Bay Area", 37.845, -122.11),
    ("clayton-mt-diablo", "Clayton & Mt Diablo North", "San Francisco Bay Area", 37.93, -121.95),
    ("mill-valley-mt-tam", "Mill Valley & Mt Tamalpais", "San Francisco Bay Area", 37.91, -122.58),
    ("angwin-howell-mountain", "Angwin & Howell Mountain", "San Francisco Bay Area", 38.56, -122.43),
    ("glen-ellen-sugarloaf", "Glen Ellen & Sugarloaf", "San Francisco Bay Area", 38.39, -122.5),
    ("fountaingrove-hood-mountain", "Fountaingrove & Hood Mountain", "San Francisco Bay Area", 38.47, -122.66),
    ("boulder-creek-big-basin", "Boulder Creek & Big Basin", "San Francisco Bay Area", 37.15, -122.17),
    ("los-gatos-sierra-azul", "Los Gatos & Sierra Azul", "San Francisco Bay Area", 37.205, -121.96),
    ("alum-rock-diablo-range", "Alum Rock & Diablo Range", "San Francisco Bay Area", 37.38, -121.79),
    ("carmel-valley-village", "Carmel Valley Village", "Central Coast", 36.47, -121.74),
    ("big-sur-pfeiffer", "Big Sur & Pfeiffer Ridge", "Central Coast", 36.25, -121.76),
    ("slo-cuesta-grade", "San Luis Obispo & Cuesta Grade", "Central Coast", 35.32, -120.65),
    ("atascadero-pine-mountain", "Atascadero & Pine Mountain", "Central Coast", 35.495, -120.67),
    ("santa-barbara-mission-canyon", "Mission Canyon & Rattlesnake Canyon", "Central Coast", 34.47, -119.7),
    ("montecito-san-ysidro", "Montecito & San Ysidro Canyon", "Central Coast", 34.46, -119.63),
    ("goleta-santa-ynez-foothills", "Goleta & Santa Ynez Foothills", "Central Coast", 34.48, -119.81),
    ("mariposa-sierra-foothills", "Mariposa & Sierra Foothills", "Central Sierra & Kern", 37.51, -119.95),
    ("oakhurst-fresno-river-foothills", "Oakhurst & Southern Yosemite Foothills", "Central Sierra & Kern", 37.35, -119.64),
    ("kernville-kern-river-canyon", "Kernville & Kern River Canyon", "Central Sierra & Kern", 35.76, -118.44),
    ("lake-isabella-bodfish", "Lake Isabella & Bodfish", "Central Sierra & Kern", 35.57, -118.48),
    ("tehachapi-mountain-park", "Tehachapi & Tehachapi Mountain Park", "Central Sierra & Kern", 35.1, -118.47),
    ("frazier-park-lebec-tejon-pass", "Frazier Park, Lebec & Tejon Pass", "Central Sierra & Kern", 34.835, -118.92),
    ("altadena-eaton-canyon", "Altadena & Eaton Canyon", "Southern California", 34.2005, -118.125),
    ("sierra-madre-foothills", "Sierra Madre & Monrovia Canyon", "Southern California", 34.185, -118.06),
    ("la-canada-flintridge", "La Cañada Flintridge & Angeles Crest", "Southern California", 34.23, -118.21),
    ("sunland-tujunga", "Sunland-Tujunga & Verdugo Hills", "Southern California", 34.28, -118.3),
    ("topanga-canyon", "Topanga & Fernwood", "Southern California", 34.09, -118.6),
    ("malibu-canyon-saddle-peak", "Malibu Canyon & Saddle Peak", "Southern California", 34.065, -118.66),
    ("western-malibu-zuma", "Western Malibu & Zuma Canyon", "Southern California", 34.05, -118.8),
    ("pacific-palisades", "Pacific Palisades & Santa Monica Mountains", "Southern California", 34.06, -118.54),
    ("castaic-hasley", "Castaic & Hasley Canyon", "Southern California", 34.51, -118.6),
    ("ojai-valley", "Ojai & Sulphur Mountain", "Southern California", 34.47, -119.23),
    ("lake-arrowhead", "Lake Arrowhead & Blue Jay", "Southern California", 34.255, -117.2),
    ("big-bear-valley", "Big Bear Lake & Fawnskin", "Southern California", 34.25, -116.9),
    ("idyllwild-pine-cove", "Idyllwild & Pine Cove", "Southern California", 33.75, -116.71),
    ("silverado-modjeska", "Silverado & Modjeska Canyons", "Southern California", 33.74, -117.63),
    ("corona-bedford-canyon", "Corona & Bedford Canyon", "Southern California", 33.81, -117.5),
    ("julian-cuyamaca", "Julian & Wynola", "Southern California", 33.07, -116.59),
    ("fallbrook-red-mountain", "Fallbrook & Red Mountain", "Southern California", 33.38, -117.23),
)

# Historical fires (region.kind = "historical_fire" in docs/shared-world.md).
HISTORICAL_FIRES = {
    "camp-2018": {
        "name": "Camp Fire (2018), Paradise",
        "lon": -121.434, "lat": 39.813,
        "point_source": "sim/firefront.py CAMP_IGNITION_LONLAT (assumed: approximate reported origin)",
        "ignition_utc": "2018-11-08T14:20:00Z",
        "ignition_source": "NIST TN 2252 Sec. 1.2, as cited in sim/ground_rates.py",
        "replay_start_utc": "2018-11-08T12:00:00Z", "replay_hours": 24,
        "phenology_class": "ca_interior_foothill",
        "sector_deg": OFFSHORE_SECTOR_DEG,
    },
    "kincade-2019": {
        "name": "Kincade Fire (2019), Geyserville",
        "lon": -122.85, "lat": 38.585,
        "point_source": "centre of the package requested_bbox (data/incidents/kincade-2019-evacuation); "
                        "a presentation point for station choice, not the origin",
        "ignition_utc": "2019-10-24T04:27:00Z",
        "ignition_source": "package ignition_utc (CAL FIRE '10/23/2019 9:27 PM')",
        "replay_start_utc": "2019-10-24T03:00:00Z", "replay_hours": 24,
        "phenology_class": "ca_coastal",
        "sector_deg": OFFSHORE_SECTOR_DEG,
    },
    "woolsey-2018": {
        "name": "Woolsey Fire (2018), Malibu",
        "lon": -118.70128, "lat": 34.235,
        "point_source": "package ignition_point_lat_lon_as_published (CAL FIRE incident page)",
        "ignition_utc": "2018-11-08T22:24:00Z",
        "ignition_source": "package first_report_utc (ignition at or shortly before)",
        "replay_start_utc": "2018-11-08T21:00:00Z", "replay_hours": 36,
        "phenology_class": "ca_coastal",
        "sector_deg": OFFSHORE_SECTOR_DEG,
    },
    "marshall-2021": {
        "name": "Marshall Fire (2021), Boulder County CO",
        "lon": -105.175, "lat": 39.965,
        "point_source": "centre of the package requested_bbox (data/incidents/marshall-2021-evacuation); "
                        "a presentation point for station choice, not the origin",
        "ignition_utc": "2021-12-30T18:05:00Z",
        "ignition_source": "package events table: Eldorado Springs Fire ignition 11:05 MST, a latest bound",
        "replay_start_utc": "2021-12-30T16:00:00Z", "replay_hours": 12,
        "phenology_class": "front_range_grassland",
        "sector_deg": FRONT_RANGE_DOWNSLOPE_SECTOR_DEG,
        "typical_season_date": "12-15",
        "weather_coverage": ("Colorado station catalogue (IEM CO_ASOS / CO_DCP; Boulder BDU and "
                             "Broomfield/Jeffco BJC within 10 km), ERA5 reanalysis as fallback"),
    },
}

NEAREST_REGION_MAX_KM = 60.0  # beyond this a point gets the default phenology class


def _phenology_for(region_id: str, area: str) -> str:
    if region_id in MONTANE_REGIONS:
        return "ca_montane"
    if area == "Central Sierra & Kern":
        return "ca_interior_foothill"
    return "ca_coastal"


def _season_date_for(region_id: str, area: str) -> str:
    return TYPICAL_SEASON_DATE["montane" if region_id in MONTANE_REGIONS else area]


def _haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    h = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 2 * r * math.asin(math.sqrt(h))


def _climatology_presets(lon, lat, month_day, sector) -> list[dict]:
    start = f"{CLIMATOLOGY_PRESET_YEAR}-{month_day}T{CLIMATOLOGY_PRESET_HOUR_UTC:02d}:00:00Z"
    out = []
    for pct, label in ((95, "Peak season, 95th percentile wind day"), (50, "Peak season, median wind day")):
        out.append({
            "id": f"peak-season-p{pct}",
            "label": label,
            "query": {"lon": lon, "lat": lat, "start": start, "hours": CLIMATOLOGY_PRESET_HOURS,
                      "mode": "climatology_percentile", "percentile": pct,
                      "sector": list(sector)},
            "evidence": {"date": "assumed (typical peak-season date for the region)",
                         "weather": "derived (climatology analog of real observed hours)"},
        })
    return out


def region_presets(region_id: str) -> dict | None:
    """Presets for one catalogue region or historical fire id, or None if unknown."""
    if region_id in HISTORICAL_FIRES:
        f = HISTORICAL_FIRES[region_id]
        month_day = f.get("typical_season_date") or f["ignition_utc"][5:10]
        presets = [{
            "id": "actual-ignition",
            "label": f"Actual fire day ({f['ignition_utc'][:10]})",
            "query": {"lon": f["lon"], "lat": f["lat"], "start": f["replay_start_utc"],
                      "hours": f["replay_hours"], "mode": "historical_replay"},
            "ignition_utc": f["ignition_utc"],
            "evidence": {"date": f"observed ({f['ignition_source']})", "weather": "observed (station archive)"},
            "point_source": f["point_source"],
        }] + _climatology_presets(f["lon"], f["lat"], month_day, f["sector_deg"])
        return {"region": {"id": region_id, "kind": "historical_fire", "name": f["name"],
                           "center": [f["lon"], f["lat"]]},
                "weather_coverage": f.get("weather_coverage", "California station catalogue, ERA5 reanalysis as fallback"),
                "phenology_class": f["phenology_class"], "typical_season_date": month_day,
                "presets": presets}
    for rid, name, area, lat, lon in CATALOGUE_REGIONS:
        if rid == region_id:
            md = _season_date_for(rid, area)
            return {"region": {"id": rid, "kind": "catalogue", "name": name, "area": area,
                               "center": [lon, lat]},
                    "weather_coverage": "California station catalogue, ERA5 reanalysis as fallback",
                    "phenology_class": _phenology_for(rid, area), "typical_season_date": md,
                    "presets": _climatology_presets(lon, lat, md, OFFSHORE_SECTOR_DEG)}
    return None


def all_region_ids() -> list[str]:
    return [r[0] for r in CATALOGUE_REGIONS] + list(HISTORICAL_FIRES)


def phenology_for_point(lon: float, lat: float, region_id: str | None = None) -> tuple[str, str]:
    """(phenology class, how it was chosen) for a query point, optionally pinned to a region id."""
    if region_id:
        rp = region_presets(region_id)
        if rp is None:
            raise ValueError(f"unknown region {region_id!r}")
        return rp["phenology_class"], f"region {region_id}"
    best = None
    for rid, _name, area, rlat, rlon in CATALOGUE_REGIONS:
        d = _haversine_km(lon, lat, rlon, rlat)
        if best is None or d < best[0]:
            best = (d, rid, _phenology_for(rid, area))
    for fid, f in HISTORICAL_FIRES.items():
        d = _haversine_km(lon, lat, f["lon"], f["lat"])
        if d < best[0]:
            best = (d, fid, f["phenology_class"])
    if best[0] <= NEAREST_REGION_MAX_KM:
        return best[2], f"nearest region {best[1]} ({best[0]:.1f} km)"
    from sim.fuel_moisture import DEFAULT_PHENOLOGY_CLASS

    return DEFAULT_PHENOLOGY_CLASS, f"default (no region within {NEAREST_REGION_MAX_KM:g} km)"
