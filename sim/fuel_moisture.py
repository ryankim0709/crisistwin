"""Dead and live fuel moisture from hourly temperature and humidity, the date and the site.

Pure standard library: no network, no Django. ``app/backend/api/conditions.py`` feeds it the
hourly series from ``sim/weather.py``. Design notes, sources and examples:
``docs/scenario-weather.md`` ("Fuel moisture from the date's weather").

Model, per hour (units in every name; oven-dry moisture is reported both in percent, as the
tables print it, and as a fraction, as ``app/src/fire/rothermel.ts`` ``FuelMoisture`` takes it):

* **1-h dead fuel moisture: derived.** Fosberg and Deeming fine dead fuel moisture tables as
  printed in Rothermel, R.C. 1983, *How to predict the spread and intensity of forest and range
  fires*, USDA Forest Service GTR INT-143, Exhibit II-2, Tables A to F (pp. 15-19), the same tables
  as the NWCG Incident Response Pocket Guide. Daytime (0800-1959): Table A reference moisture
  plus the month's correction (Table B May-July; Table C Feb-Apr and Aug-Oct; Table D Nov-Jan)
  for exposure, aspect, slope and elevation band. Nighttime (2000-0759): Table E reference, with
  the Table F correction only when a strong inversion is declared (Exhibit II-2 line p: "Use table
  F only if a strong inversion exists"). Tables reproduced cell for cell from the scanned report;
  ``rothermel_1983_worked_examples`` reproduces the report's six answers (p. 20).
* **10-h and 100-h dead fuel moisture: derived, with an assumed forcing and start.** First-order
  timelag response: ``dm/dt = (E - m) / tau``, the definition of a timelag class (the e-folding
  time; Byram 1963, Fosberg 1970), integrated exactly over each hour with ``tau = 10 h`` and
  ``100 h``. The equilibrium ``E`` each hour is taken to be that hour's 1-h table value (assumption:
  1-h fuels reach equilibrium within the hour, so the site-corrected table value stands in for the
  local equilibrium moisture). The starting state is the mean of ``E`` over the first 24 forcing
  hours (assumption), after an observed spin-up where the caller provides one.
* **Live herbaceous and woody moisture: assumed.** Rothermel 1983 Table II-2 (p. 13) gives the
  moisture of each stage of vegetative development (fresh 300 %, maturing 200 %, mature 100 %,
  entering dormancy 50 %, completely cured < 30 % "treat as a dead fuel", used here as 30 %). Which
  stage applies on a date is an ASSUMED regional phenology calendar (``PHENOLOGY_CALENDARS``),
  interpolated linearly between mid-month anchors (the report's own example interpolates between
  stages, p. 13). Not observed: replace with measured live fuel moisture when available. Since
  ``live-gsi/1`` this calendar is only the fallback: ``/api/conditions`` overwrites live moisture with
  the NFDRS 2016 Growing Season Index value of ``sim/live_moisture.py`` when its ERA5 lead-in loads.

Not modelled (stated, not hidden): precipitation and dew (the report's CAUTION, p. 13: the tables
"assume that there has not been recent precipitation"; after rain these values are too dry),
cloud cover (pass ``shading="shaded"`` for overcast hours), and wetting/drying hysteresis.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

MODEL_VERSION = "fuel-moisture/1"

# --------------------------------------------------------------------------- Rothermel 1983 tables

# Table A rows and Table E rows: dry-bulb temperature bands, deg F (Rothermel 1983 p. 17, p. 19).
# Row 0 is "10-29"; temperatures below 10 F are outside the table and use row 0 (flagged).
TEMP_BAND_LABELS_F = ("10-29", "30-49", "50-69", "70-89", "90-109", "109+")
# Columns: relative humidity 0-4, 5-9, ..., 95-99 (20 bands) and 100 (Rothermel 1983 p. 17).
RH_BAND_LABELS_PCT = tuple(f"{5 * i}-{5 * i + 4}" for i in range(20)) + ("100",)

# Rothermel 1983 Exhibit II-2 Table A, "Reference fuel moisture, day time 0800-1959", percent.
TABLE_A_DAY_REFERENCE_PCT = (
    (1, 2, 2, 3, 4, 5, 5, 6, 7, 8, 8, 8, 9, 9, 10, 11, 12, 12, 13, 13, 14),  # 10-29 F
    (1, 2, 2, 3, 4, 5, 5, 6, 7, 7, 7, 8, 9, 9, 10, 10, 11, 12, 13, 13, 13),  # 30-49 F
    (1, 2, 2, 3, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 11, 12, 12, 12, 13),  # 50-69 F
    (1, 1, 2, 2, 3, 4, 5, 5, 6, 7, 7, 8, 8, 8, 9, 10, 10, 11, 12, 12, 13),  # 70-89 F
    (1, 1, 2, 2, 3, 4, 4, 5, 6, 7, 7, 8, 8, 8, 9, 10, 10, 11, 12, 12, 13),  # 90-109 F
    (1, 1, 2, 2, 3, 4, 4, 5, 6, 7, 7, 8, 8, 8, 9, 10, 10, 11, 12, 12, 12),  # 109+ F
)

# The report prints "25+" in some night cells. Stored as this value and flagged as a lower bound.
TABLE_E_CAP_PCT = 25
_P = TABLE_E_CAP_PCT
# Rothermel 1983 Exhibit II-2 Table E, "Reference fuel moisture, night time 2000-0759", percent.
TABLE_E_NIGHT_REFERENCE_PCT = (
    (1, 2, 4, 5, 5, 6, 7, 8, 9, 10, 11, 12, 12, 14, 15, 17, 19, 22, 25, _P, _P),  # 10-29 F
    (1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 11, 11, 12, 13, 14, 16, 18, 21, 24, _P, _P),  # 30-49 F
    (1, 2, 3, 4, 5, 6, 6, 8, 8, 9, 10, 11, 11, 12, 14, 16, 17, 20, 23, _P, _P),  # 50-69 F
    (1, 2, 3, 4, 4, 5, 6, 7, 8, 9, 10, 10, 11, 12, 13, 15, 17, 20, 23, _P, _P),  # 70-89 F
    (1, 2, 3, 3, 4, 5, 6, 7, 8, 9, 9, 10, 10, 11, 13, 14, 16, 19, 22, 25, _P),  # 90-109 F
    (1, 2, 2, 3, 4, 5, 6, 6, 8, 8, 9, 9, 10, 11, 12, 14, 16, 19, 21, 24, _P),  # 109+ F
)
# Which Table E cells are printed "25+" (row, column).
TABLE_E_25_PLUS_CELLS = frozenset(
    {(r, c) for r in range(4) for c in (19, 20)} | {(4, 20), (5, 20)}
)

# Daytime correction tables, Rothermel 1983 Exhibit II-2 Tables B, C, D (pp. 17-18), percent.
# Columns: six time bands (0800, 1000, 1200, 1400, 1600, 1800 onwards), each with
# B (projection point 1000-2000 ft below the weather site), L (within +/-1000 ft), A (1000-2000 ft
# above), i.e. index = 3 * band + {"B": 0, "L": 1, "A": 2}.
# Exposed rows: (aspect, slope class) with slope class "0-30" or "31+" percent.
# Shaded rows (>= 50 % shading of surface fuels, by canopy or cloud): aspect only, any slope.
TABLE_B_MAY_JUL_PCT = {
    "exposed": {
        ("N", "0-30"): (2, 3, 4, 1, 1, 1, 0, 0, 1, 0, 0, 1, 1, 1, 1, 2, 3, 4),
        ("N", "31+"): (3, 4, 4, 1, 2, 2, 1, 1, 2, 1, 1, 2, 1, 2, 2, 3, 4, 4),
        ("E", "0-30"): (2, 2, 3, 1, 1, 1, 0, 0, 1, 0, 0, 1, 1, 1, 2, 3, 4, 4),
        ("E", "31+"): (1, 2, 2, 0, 0, 1, 0, 0, 1, 1, 1, 2, 2, 3, 4, 4, 5, 6),
        ("S", "0-30"): (2, 3, 3, 1, 1, 1, 0, 0, 1, 0, 0, 1, 1, 1, 1, 2, 3, 3),
        ("S", "31+"): (2, 3, 3, 1, 1, 2, 0, 1, 1, 0, 1, 1, 1, 1, 2, 2, 3, 3),
        ("W", "0-30"): (2, 3, 4, 1, 1, 2, 0, 0, 1, 0, 0, 1, 0, 1, 1, 2, 3, 3),
        ("W", "31+"): (4, 5, 6, 2, 3, 4, 1, 1, 2, 0, 0, 1, 0, 0, 1, 1, 2, 2),
    },
    "shaded": {
        "N": (4, 5, 5, 3, 4, 5, 3, 3, 4, 3, 3, 4, 3, 4, 5, 4, 5, 5),
        "E": (4, 4, 5, 3, 4, 5, 3, 3, 4, 3, 4, 4, 3, 4, 5, 4, 5, 6),
        "S": (4, 4, 5, 3, 4, 5, 3, 3, 4, 3, 3, 4, 3, 4, 5, 4, 5, 5),
        "W": (4, 5, 6, 3, 4, 5, 3, 3, 4, 3, 3, 4, 3, 4, 5, 4, 4, 5),
    },
}
TABLE_C_FEB_APR_AUG_OCT_PCT = {
    "exposed": {
        ("N", "0-30"): (3, 4, 5, 1, 2, 3, 1, 1, 2, 1, 1, 2, 1, 2, 3, 3, 4, 5),
        ("N", "31+"): (3, 4, 5, 3, 3, 4, 2, 3, 4, 2, 3, 4, 3, 3, 4, 3, 4, 5),
        ("E", "0-30"): (3, 4, 5, 1, 2, 3, 1, 1, 1, 1, 1, 2, 1, 2, 3, 3, 4, 5),
        ("E", "31+"): (3, 3, 4, 1, 1, 1, 1, 1, 1, 1, 2, 3, 3, 4, 5, 4, 5, 6),
        ("S", "0-30"): (3, 4, 5, 1, 2, 2, 1, 1, 1, 1, 1, 1, 1, 2, 3, 3, 4, 5),
        ("S", "31+"): (3, 4, 5, 1, 2, 2, 0, 1, 1, 0, 1, 1, 1, 2, 2, 3, 4, 5),
        ("W", "0-30"): (3, 4, 5, 1, 2, 3, 1, 1, 1, 1, 1, 1, 1, 2, 3, 3, 4, 5),
        ("W", "31+"): (4, 5, 6, 3, 4, 5, 1, 2, 3, 1, 1, 1, 1, 1, 1, 3, 3, 4),
    },
    "shaded": {
        "N": (4, 5, 6, 4, 5, 5, 3, 4, 5, 3, 4, 5, 4, 5, 5, 4, 5, 6),
        "E": (4, 5, 6, 3, 4, 5, 3, 4, 5, 3, 4, 5, 4, 5, 6, 4, 5, 6),
        "S": (4, 5, 6, 3, 4, 5, 3, 4, 5, 3, 4, 5, 3, 4, 5, 4, 5, 6),
        "W": (4, 5, 6, 4, 5, 6, 3, 4, 5, 3, 4, 5, 3, 4, 5, 4, 5, 6),
    },
}
TABLE_D_NOV_JAN_PCT = {
    "exposed": {
        ("N", "0-30"): (4, 5, 6, 3, 4, 5, 2, 3, 4, 2, 3, 4, 3, 4, 5, 4, 5, 6),
        ("N", "31+"): (4, 5, 6, 4, 5, 6, 4, 5, 6, 4, 5, 6, 4, 5, 6, 4, 5, 6),
        ("E", "0-30"): (4, 5, 6, 3, 4, 4, 2, 3, 3, 2, 3, 3, 3, 4, 5, 4, 5, 6),
        ("E", "31+"): (4, 5, 6, 2, 3, 4, 2, 2, 3, 3, 4, 4, 4, 5, 6, 4, 5, 6),
        ("S", "0-30"): (4, 5, 6, 3, 4, 5, 2, 3, 3, 2, 2, 3, 3, 4, 4, 4, 5, 6),
        ("S", "31+"): (4, 5, 6, 2, 3, 3, 1, 1, 2, 1, 1, 2, 2, 3, 3, 4, 5, 6),
        ("W", "0-30"): (4, 5, 6, 3, 4, 5, 2, 3, 3, 2, 3, 3, 3, 4, 4, 4, 5, 6),
        ("W", "31+"): (4, 5, 6, 4, 5, 6, 3, 4, 4, 2, 2, 3, 2, 3, 4, 4, 5, 6),
    },
    "shaded": dict.fromkeys(("N", "E", "S", "W"), (4, 5, 6) * 6),
}
# Rothermel 1983 Exhibit II-2 Table F, nighttime corrections (strong inversion only), percent.
# Rows: "N+E" and "S+W" aspects. Columns as above, bands 2000, 2200, 0000, 0200, 0400, 0600.
TABLE_F_NIGHT_INVERSION_PCT = {
    "N+E": (9, 1, 1, 13, 1, 2, 16, 2, 2, 17, 1, 1, 18, 1, 1, 16, 2, 1),
    "S+W": (9, 0, 1, 14, 0, 1, 16, 0, 2, 17, 0, 1, 18, 0, 0, 9, 0, 1),
}

DAY_START_HOUR_LOCAL = 8  # "Daytime projections are for 0800-1959" (Rothermel 1983 p. 15, line b)
NIGHT_START_HOUR_LOCAL = 20
SLOPE_CLASS_BREAK_PCT = 30  # Tables B-D rows "0-30%" and "31%+"
ELEVATION_BANDS = ("B", "L", "A")  # below / level (+/-1000 ft) / above the weather site
ASPECTS = ("N", "E", "S", "W")
SHADING = ("exposed", "shaded")  # exposed: < 50 % shading of surface fuels; shaded: >= 50 %

# Months (1-12) -> daytime correction table (Rothermel 1983 Tables B, C, D titles).
MONTH_TABLE = {
    5: "B", 6: "B", 7: "B",
    2: "C", 3: "C", 4: "C", 8: "C", 9: "C", 10: "C",
    11: "D", 12: "D", 1: "D",
}
_DAY_TABLES = {"B": TABLE_B_MAY_JUL_PCT, "C": TABLE_C_FEB_APR_AUG_OCT_PCT, "D": TABLE_D_NOV_JAN_PCT}

# --------------------------------------------------------------------------- timelag constants

TIMELAG_10H_HOURS = 10.0  # timelag class definition (Byram 1963; Fosberg 1970)
TIMELAG_100H_HOURS = 100.0
LAG_INIT_WINDOW_HOURS = 24  # assumption: lagged classes start at the mean forcing of the first day
MAX_FILL_GAP_HOURS = 3  # assumption: temperature/RH gaps up to this long are filled linearly

# --------------------------------------------------------------------------- live moisture

# Rothermel 1983 Table II-2 (p. 13), stage of vegetative development -> moisture, percent.
# "cured" is printed "Less than 30, treat as a dead fuel"; 30 % is used, which is also the fully
# cured point of the Scott & Burgan dynamic models in app/src/fire/rothermel.ts.
LIVE_STAGE_MOISTURE_PCT = {
    "fresh": 300.0,  # fresh foliage, annuals developing, early in growing cycle
    "maturing": 200.0,  # maturing foliage, still developing with full turgor
    "mature": 100.0,  # mature foliage, new growth complete
    "dormancy": 50.0,  # entering dormancy, coloration starting, some leaves dropped
    "cured": 30.0,  # completely cured (< 30 %, treated as dead)
}

# ASSUMED regional phenology calendars: the stage on the 15th of each month (Jan..Dec), for the
# herbaceous layer (annual grasses and forbs) and the woody layer (shrub foliage). These are
# planning assumptions written from the general seasonal pattern of each climate (Mediterranean
# winter-wet/summer-dry California; snow-season montane; continental Front Range), NOT measured
# live fuel moisture and not from a cited dataset.
PHENOLOGY_CALENDARS = {
    "ca_coastal": {
        "label": "California coast ranges and coastal foothills (fog belt, winter rains)",
        "herb": ("fresh", "fresh", "maturing", "mature", "mature", "dormancy",
                 "cured", "cured", "cured", "cured", "cured", "cured"),
        "woody": ("mature", "mature", "maturing", "maturing", "mature", "mature",
                  "mature", "dormancy", "dormancy", "dormancy", "dormancy", "dormancy"),
    },
    "ca_interior_foothill": {
        "label": "California interior foothills (Sierra Nevada and Kern foothills; earlier curing)",
        "herb": ("fresh", "fresh", "maturing", "mature", "dormancy", "cured",
                 "cured", "cured", "cured", "cured", "cured", "cured"),
        "woody": ("mature", "mature", "mature", "maturing", "maturing", "mature",
                  "dormancy", "dormancy", "dormancy", "dormancy", "dormancy", "mature"),
    },
    "ca_montane": {
        "label": "Southern California mountains above ~1500 m (snow season, late spring green-up)",
        "herb": ("cured", "cured", "cured", "fresh", "maturing", "mature",
                 "dormancy", "cured", "cured", "cured", "cured", "cured"),
        "woody": ("mature", "mature", "mature", "mature", "maturing", "maturing",
                  "mature", "dormancy", "dormancy", "dormancy", "dormancy", "mature"),
    },
    "front_range_grassland": {
        "label": "Colorado Front Range grassland and foothills (winter-dormant)",
        "herb": ("cured", "cured", "cured", "fresh", "maturing", "mature",
                 "dormancy", "cured", "cured", "cured", "cured", "cured"),
        "woody": ("dormancy", "dormancy", "dormancy", "dormancy", "maturing", "maturing",
                  "mature", "mature", "dormancy", "dormancy", "dormancy", "dormancy"),
    },
}
DEFAULT_PHENOLOGY_CLASS = "ca_coastal"


# --------------------------------------------------------------------------- helpers


def c_to_f(temp_c: float) -> float:
    return temp_c * 9.0 / 5.0 + 32.0


def temp_row(temp_f: float) -> tuple[int, bool]:
    """Table row for a dry-bulb temperature in deg F; second value True when outside the table."""
    t = round(temp_f)
    if t < 10:
        return 0, True
    if t <= 29:
        return 0, False
    if t <= 49:
        return 1, False
    if t <= 69:
        return 2, False
    if t <= 89:
        return 3, False
    if t <= 109:
        return 4, False
    return 5, False


def rh_column(rh_pct: float) -> int:
    """Table column for relative humidity in percent (0-4 -> 0, ..., 95-99 -> 19, 100 -> 20)."""
    h = min(100, max(0, round(rh_pct)))
    return 20 if h >= 100 else h // 5


def slope_class(slope_pct: float) -> str:
    return "0-30" if slope_pct <= SLOPE_CLASS_BREAK_PCT else "31+"


def aspect_class(aspect: str | float) -> str:
    """'N', 'E', 'S' or 'W'; a bearing in degrees is binned to the nearest cardinal aspect."""
    if isinstance(aspect, str):
        a = aspect.strip().upper()
        if a not in ASPECTS:
            raise ValueError(f"aspect must be one of {ASPECTS} or a bearing in degrees")
        return a
    return ASPECTS[int(((float(aspect) % 360.0) + 45.0) // 90.0) % 4]


def local_mean_solar_time(t_utc: datetime, lon_deg: float) -> datetime:
    """Local mean solar time: UTC + lon/15 h (assumption: the tables' clock bands are solar time).

    Returned as a naive datetime (it is not a civil time zone).
    """
    t = t_utc.astimezone(UTC).replace(tzinfo=None)
    return t + timedelta(hours=lon_deg / 15.0)


# --------------------------------------------------------------------------- 1-h moisture


@dataclass(frozen=True)
class Site:
    """Projection point relative to the weather site (Rothermel 1983 Exhibit II-2 lines g-k, q-t)."""

    aspect: str = "S"
    slope_pct: float = 0.0
    shading: str = "exposed"
    elevation_band: str = "L"
    night_inversion: bool = False
    station_aspect: str = "S"  # Table F only: aspect of the temperature/RH site

    def validated(self) -> Site:
        if self.shading not in SHADING:
            raise ValueError(f"shading must be one of {SHADING}")
        if self.elevation_band not in ELEVATION_BANDS:
            raise ValueError(f"elevation_band must be one of {ELEVATION_BANDS}")
        if not (0 <= self.slope_pct <= 1000):
            raise ValueError("slope_pct must be 0 to 1000")
        return Site(aspect_class(self.aspect), float(self.slope_pct), self.shading,
                    self.elevation_band, bool(self.night_inversion), aspect_class(self.station_aspect))


def _table_f_row(aspect: str) -> str:
    return "N+E" if aspect in ("N", "E") else "S+W"


def fine_dead_fuel_moisture(
    temp_f: float, rh_pct: float, local_hour: int, local_month: int, site: Site
) -> dict:
    """1-h dead fuel moisture, percent, from Rothermel 1983 Exhibit II-2.

    ``local_hour`` 0-23 and ``local_month`` 1-12 are local (solar) clock values. Returns
    ``{moisture_pct, period, reference_pct, correction_pct, table, reference_is_lower_bound,
    temp_outside_table}``.
    """
    site = site.validated()
    row, outside = temp_row(temp_f)
    col = rh_column(rh_pct)
    off = ELEVATION_BANDS.index(site.elevation_band)
    if DAY_START_HOUR_LOCAL <= local_hour < NIGHT_START_HOUR_LOCAL:
        ref = TABLE_A_DAY_REFERENCE_PCT[row][col]
        letter = MONTH_TABLE[local_month]
        band = (local_hour - DAY_START_HOUR_LOCAL) // 2  # 0800, 1000, ..., 1800 onwards
        table = _DAY_TABLES[letter]
        if site.shading == "shaded":
            corr = table["shaded"][site.aspect][3 * band + off]
        else:
            corr = table["exposed"][(site.aspect, slope_class(site.slope_pct))][3 * band + off]
        return {
            "moisture_pct": float(ref + corr), "period": "day", "reference_pct": ref,
            "correction_pct": corr, "table": f"A+{letter}", "reference_is_lower_bound": False,
            "temp_outside_table": outside,
        }
    ref = TABLE_E_NIGHT_REFERENCE_PCT[row][col]
    capped = (row, col) in TABLE_E_25_PLUS_CELLS
    if not site.night_inversion:
        # Exhibit II-2 line p: without a strong inversion the Table E value is used directly.
        return {
            "moisture_pct": float(ref), "period": "night", "reference_pct": ref, "correction_pct": 0,
            "table": "E", "reference_is_lower_bound": capped, "temp_outside_table": outside,
        }
    band = ((local_hour - NIGHT_START_HOUR_LOCAL) % 24) // 2  # 2000, 2200, 0000, ..., 0600
    point = TABLE_F_NIGHT_INVERSION_PCT[_table_f_row(site.aspect)][3 * band + off]
    station = TABLE_F_NIGHT_INVERSION_PCT[_table_f_row(site.station_aspect)][3 * band + 1]
    corr = point - station  # Exhibit II-2 lines u, v, w: projection point minus site (L)
    return {
        "moisture_pct": float(ref + corr), "period": "night", "reference_pct": ref,
        "correction_pct": corr, "table": "E+F", "reference_is_lower_bound": capped,
        "temp_outside_table": outside,
    }


def rothermel_1983_worked_examples() -> list[dict]:
    """The report's two worked examples (Rothermel 1983 p. 20) against this implementation."""
    cases = [
        ("1a", 80, 20, 13, 8, Site("N", 35, "exposed", "L"), 6),
        ("1b", 80, 20, 13, 8, Site("E", 35, "exposed", "B"), 4),
        ("1c", 80, 20, 13, 8, Site("N", 35, "shaded", "L"), 7),
        ("2a", 60, 50, 23, 8, Site("N", 0, "exposed", "L"), 10),
        ("2b", 60, 50, 23, 8, Site("S", 0, "exposed", "L", True, "N"), 9),
        ("2c", 60, 50, 23, 8, Site("N", 0, "exposed", "B", True, "N"), 22),
    ]
    out = []
    for name, t, h, hour, month, site, published in cases:
        got = fine_dead_fuel_moisture(t, h, hour, month, site)["moisture_pct"]
        out.append({"example": name, "published_pct": published, "computed_pct": got,
                    "match": got == published})
    return out


# --------------------------------------------------------------------------- live moisture


def live_fuel_moisture(local_day: date, phenology_class: str) -> dict:
    """Live herbaceous and woody moisture, percent and fraction, for a local calendar day.

    Linear interpolation between the stage values of the two nearest mid-month (15th) anchors of
    the class's ASSUMED calendar.
    """
    cal = PHENOLOGY_CALENDARS.get(phenology_class)
    if cal is None:
        raise ValueError(f"unknown phenology class {phenology_class!r}")
    y = local_day.year
    anchor = date(y, local_day.month, 15)
    if local_day >= anchor:
        m0 = local_day.month
        a0 = anchor
        m1 = m0 % 12 + 1
        a1 = date(y + (m0 == 12), m1, 15)
    else:
        m1 = local_day.month
        a1 = anchor
        m0 = (m1 - 2) % 12 + 1
        a0 = date(y - (m1 == 1), m0, 15)
    w = (local_day - a0).days / (a1 - a0).days
    out = {"phenology_class": phenology_class}
    for layer, key in (("herb", "liveHerb"), ("woody", "liveWoody")):
        s0, s1 = cal[layer][m0 - 1], cal[layer][m1 - 1]
        pct = LIVE_STAGE_MOISTURE_PCT[s0] * (1 - w) + LIVE_STAGE_MOISTURE_PCT[s1] * w
        out[f"{layer}_pct"] = round(pct, 1)
        out[key] = round(pct / 100.0, 4)
        out[f"{layer}_stage"] = s0 if w < 0.5 else s1
        out[f"{layer}_between"] = [s0, s1]
    return out


# --------------------------------------------------------------------------- hourly series


def fill_short_gaps(values: Sequence[float | None], max_gap: int = MAX_FILL_GAP_HOURS):
    """Linear fill of interior gaps of at most ``max_gap`` hours. Returns (values, filled_flags)."""
    vals = list(values)
    filled = [False] * len(vals)
    i = 0
    while i < len(vals):
        if vals[i] is not None:
            i += 1
            continue
        j = i
        while j < len(vals) and vals[j] is None:
            j += 1
        if i > 0 and j < len(vals) and (j - i) <= max_gap:
            a, b = vals[i - 1], vals[j]
            for k in range(i, j):
                vals[k] = a + (b - a) * (k - i + 1) / (j - i + 1)
                filled[k] = True
        i = j
    return vals, filled


def moisture_series(
    samples: Sequence[dict],
    lon_deg: float,
    site: Site,
    phenology_class: str,
    *,
    spinup_samples: Sequence[dict] = (),
    clock_shift: timedelta = timedelta(0),
) -> dict:
    """Per-hour dead and live moisture for hourly samples ``{t_utc, temp_c, rh_pct}``.

    ``spinup_samples``: earlier hours (same station) that only warm up the 10-h/100-h state.
    ``clock_shift``: added to each ``t_utc`` before the clock-dependent table lookups and the live
    calendar; a climatology analog relabelled to a new start passes (analog start - scenario start)
    so the tables see the hours the temperature and humidity were really observed at.

    Returns ``{hours: [{t_utc, moisture{dead1h, dead10h, dead100h, liveHerb, liveWoody},
    fine_fuel{...}, live{...}, met_filled}], spinup_hours_used, lag_initial_pct}``; fractions are
    of oven-dry weight, ``None`` where the hour has no temperature or humidity.
    """
    site = site.validated()
    allrows = list(spinup_samples) + list(samples)
    n_spin = len(spinup_samples)
    temps, tfill = fill_short_gaps([s.get("temp_c") for s in allrows])
    rhs, hfill = fill_short_gaps([s.get("rh_pct") for s in allrows])
    one_h: list[dict | None] = []
    for s, tc, rh in zip(allrows, temps, rhs, strict=True):
        if tc is None or rh is None:
            one_h.append(None)
            continue
        t = datetime.fromisoformat(s["t_utc"].replace("Z", "+00:00")) + clock_shift
        lt = local_mean_solar_time(t, lon_deg)
        one_h.append({**fine_dead_fuel_moisture(c_to_f(tc), rh, lt.hour, lt.month, site),
                      "local_solar_time": lt.strftime("%Y-%m-%dT%H:%M")})
    forcing = [d["moisture_pct"] if d else None for d in one_h]
    first = [f for f in forcing[:LAG_INIT_WINDOW_HOURS] if f is not None]
    if not first:
        first = [f for f in forcing if f is not None][:LAG_INIT_WINDOW_HOURS]
    init = sum(first) / len(first) if first else None
    m10 = m100 = init
    k10 = math.exp(-1.0 / TIMELAG_10H_HOURS)
    k100 = math.exp(-1.0 / TIMELAG_100H_HOURS)
    lag10: list[float | None] = []
    lag100: list[float | None] = []
    held: list[bool] = []
    prev_e: float | None = None
    for i, e in enumerate(forcing):
        if i > 0 and m10 is not None:
            if prev_e is not None:
                # Exact solution of dm/dt = (E - m)/tau over one hour with E held at the
                # previous hour's value.
                m10 = prev_e + (m10 - prev_e) * k10
                m100 = prev_e + (m100 - prev_e) * k100
        lag10.append(m10)
        lag100.append(m100)
        held.append(i > 0 and prev_e is None)
        prev_e = e
    hours = []
    for i in range(n_spin, len(allrows)):
        s = allrows[i]
        d = one_h[i]
        t = datetime.fromisoformat(s["t_utc"].replace("Z", "+00:00")) + clock_shift
        live = live_fuel_moisture(local_mean_solar_time(t, lon_deg).date(), phenology_class)
        moisture = {
            "dead1h": round(d["moisture_pct"] / 100.0, 4) if d else None,
            "dead10h": round(lag10[i] / 100.0, 4) if (d and lag10[i] is not None) else None,
            "dead100h": round(lag100[i] / 100.0, 4) if (d and lag100[i] is not None) else None,
            "liveHerb": live["liveHerb"],
            "liveWoody": live["liveWoody"],
        }
        hours.append({
            "t_utc": s["t_utc"],
            "moisture": moisture,
            "fine_fuel": d,
            "dead_lag_pct": {
                "dead10h": None if lag10[i] is None else round(lag10[i], 2),
                "dead100h": None if lag100[i] is None else round(lag100[i], 2),
                "held_through_gap": held[i],
            },
            "live": {k: live[k] for k in ("herb_pct", "woody_pct", "herb_stage", "woody_stage",
                                          "herb_between", "woody_between")},
            "met_filled": tfill[i] or hfill[i],
        })
    return {
        "hours": hours,
        "spinup_hours_used": n_spin,
        "lag_initial_pct": None if init is None else round(init, 2),
    }
