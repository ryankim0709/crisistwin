"""Forecast-versus-observed wind error from archived NWS Fire Weather Planning Forecasts.

Source of the archived forecasts: the Iowa Environmental Mesonet NWS text-product archive
(``cgi-bin/afos/retrieve.py``, free, no key, NWS products are public domain). The product is the
FWF ("Fire Weather Planning Forecast"), which gives per-zone, per-period 20-foot wind ranges in
mph, e.g. ``North winds 15 to 21 mph. Local gusts up to 50 mph``. Observed wind comes from
``sim.weather`` (ASOS and RAWS, converted to m/s).

What this measures, and what it does not:

* A forecast is a zone-wide range for a 12 h period; a station is a point. The comparison
  quantifies how far a point observation sits from the zone forecast, which is what a scenario
  "wind shift" inject has to cover. It is not a verification score for the forecaster.
* The zone/sub-area assigned to each station is an ASSUMPTION made by us (``STATION_ZONES``),
  not published by NWS.
* Speeds in the forecast are 20 ft winds; ASOS winds are 10 m. No height conversion is applied.

Units follow ``sim.weather``: m/s, wind-from degrees true, UTC. Direction error is
``observed - forecast`` in degrees, signed (positive = observed wind veered clockwise of the
forecast).
"""

from __future__ import annotations

import json
import math
import re
import statistics
import urllib.parse
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Optional, Sequence

from sim import weather as W

AFOS_URL = "https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py"
AFOS_LIST_URL = "https://mesonet.agron.iastate.edu/api/1/nws/afos/list.json"

COMPASS_DEG = {
    "north": 0.0,
    "northeast": 45.0,
    "east": 90.0,
    "southeast": 135.0,
    "south": 180.0,
    "southwest": 225.0,
    "west": 270.0,
    "northwest": 315.0,
}


@dataclass(frozen=True)
class FwfWind:
    """One zone, one forecast period, one sub-area ('all', 'valley' or 'ridge')."""

    zone: str
    period: str
    sub_area: str
    window_start_utc: str
    window_end_utc: str
    from_deg: Optional[float]
    speed_lo_ms: Optional[float]
    speed_hi_ms: Optional[float]
    gust_ms: Optional[float]
    text: str
    multi_phase: bool = False  # forecast text changes direction/speed within the period


_TIME_LINE = re.compile(r"^\s*(\d{1,4}) (AM|PM) (P[SD]T) ")
_PERIOD = re.compile(r"^\.([A-Z0-9' ]+?)\.\.\.")
_WINDS = re.compile(
    r"(?P<dir>north|northeast|east|southeast|south|southwest|west|northwest)\s+winds?"
    r"(?:\s+(?P<mod>around|up to))?\s*(?P<a>\d+)?(?:\s+to\s+(?P<b>\d+))?\s*mph",
    re.I,
)
_MULTI = re.compile(r"\b(shifting|becoming|increasing|decreasing|diminishing|then)\b", re.I)
MIN_SPEED_FOR_DIRECTION_MS = 2.0  # below this the vector-mean direction is noise
_GUST = re.compile(r"gusts?\s+(?:up\s+)?to\s+(?:around\s+)?(\d+)(?:\s+to\s+(\d+))?\s*mph", re.I)


def split_zones(text: str) -> list[tuple[list[str], str]]:
    """Split an FWF into ``([zone ids], body_text)``. Zone header like ``CAZ220-267-092300-``."""
    lines = text.splitlines()
    out: list[tuple[list[str], str]] = []
    hdr = re.compile(r"^(CAZ\d{3}(?:-\d{3})*)-\d{6}-\s*$")
    cur: Optional[tuple[list[str], list[str]]] = None
    for ln in lines:
        m = hdr.match(ln)
        if m:
            if cur:
                out.append((cur[0], "\n".join(cur[1])))
            parts = m.group(1).split("-")
            zones = ["CAZ" + parts[0][3:]] + ["CAZ" + p for p in parts[1:]]
            cur = (zones, [])
        elif cur is not None:
            cur[1].append(ln)
    if cur:
        out.append((cur[0], "\n".join(cur[1])))
    return out


def _local_offset_hours(body: str) -> int:
    for ln in body.splitlines():
        m = _TIME_LINE.match(ln)
        if m:
            return -8 if m.group(3) == "PST" else -7
    raise W.WeatherError("zone block has no issue-time line (PST/PDT)")


def _wind_block(period_text: str) -> Optional[str]:
    """Text of the '20-foot winds' bullet of one period, continuation lines included."""
    lines = period_text.splitlines()
    for i, ln in enumerate(lines):
        if re.match(r"^\*\s*20-foot winds", ln, re.I):
            block = [ln]
            for nxt in lines[i + 1 :]:
                if re.match(r"^\*\s\S", nxt) or re.match(r"^\.[A-Z]", nxt) or nxt.startswith("$$"):
                    break  # next top-level bullet / next period / end of zone
                block.append(nxt)
            return " ".join(" ".join(block).split())
    return None


def _parse_wind_text(text: str) -> tuple[Optional[float], Optional[float], Optional[float], Optional[float]]:
    """(from_deg, lo_ms, hi_ms, gust_ms) from the first wind phrase in ``text``."""
    m = _WINDS.search(text)
    if not m:
        return None, None, None, None
    direction = COMPASS_DEG[m.group("dir").lower()]
    a, b = m.group("a"), m.group("b")
    if a is None:
        return direction, None, None, None
    lo, hi = float(a), float(b) if b else float(a)
    if (m.group("mod") or "").lower() == "up to":
        lo = 0.0
    g = _GUST.search(text)
    gust = None
    if g:
        gust = float(g.group(2) or g.group(1)) * W.MPH_MS
    return direction, lo * W.MPH_MS, hi * W.MPH_MS, gust


def _split_sub_areas(block: str) -> dict[str, str]:
    """Split a wind bullet into {'valley': ..., 'ridge': ...} if the FWF gives both."""
    m = re.search(r"Valleys/Lwr Slopes\.*\s*(.*?)\s*Ridges/Upr Slopes\.*\s*(.*)$", block, re.I)
    if m:
        return {"valley": m.group(1), "ridge": m.group(2)}
    return {"all": block}


def period_windows(first_name: str, names: Sequence[str], issued: datetime, offset_h: int):
    """UTC (start, end) per period. Day = 06:00-18:00 local, night = 18:00-06:00 local.

    The first period starts at the issue time. ASSUMPTION: NWS period names that do not contain
    "NIGHT" or "TONIGHT" (including holidays such as COLUMBUS DAY) are daytime periods.
    """
    tz = timezone(timedelta(hours=offset_h))
    loc = issued.astimezone(tz)

    def is_night(name: str) -> bool:
        return "NIGHT" in name

    out = []
    start = issued
    for i, name in enumerate(names):
        night = is_night(name)
        if i == 0:
            day0 = loc.replace(hour=0, minute=0, second=0, microsecond=0)
            end_local = (
                day0 + timedelta(hours=18) if not night else day0 + timedelta(days=1, hours=6)
            )
            if not night and loc.hour >= 18:
                end_local += timedelta(days=1)
            end = end_local.astimezone(timezone.utc)
        else:
            end = start + timedelta(hours=12)
        out.append((start, end))
        start = end
    return out


def parse_fwf(text: str, issued_utc: datetime, max_periods: int = 4) -> list[FwfWind]:
    """All zone/period/sub-area wind forecasts in one FWF product.

    ``issued_utc`` comes from the product id (``YYYYMMDDHHMM-WFO-...``), because the WMO header
    carries only day/hour/minute.
    """
    issued = W.require_utc(issued_utc, "issued_utc")
    results: list[FwfWind] = []
    for zones, body in split_zones(text):
        try:
            off = _local_offset_hours(body)
        except W.WeatherError:
            continue
        # period blocks
        chunks: list[tuple[str, str]] = []
        cur_name, cur_lines = None, []
        for ln in body.splitlines():
            pm = _PERIOD.match(ln)
            if pm:
                if cur_name is not None:
                    chunks.append((cur_name, "\n".join(cur_lines)))
                cur_name, cur_lines = pm.group(1).strip(), []
            elif cur_name is not None:
                if ln.startswith("$$"):
                    break
                cur_lines.append(ln)
        if cur_name is not None:
            chunks.append((cur_name, "\n".join(cur_lines)))
        chunks = [c for c in chunks if c[0] not in ("EXTENDED",) and _wind_block(c[1])][:max_periods]
        names = [c[0] for c in chunks]
        windows = period_windows(names[0], names, issued, off) if names else []
        for (name, ptext), (ws, we) in zip(chunks, windows):
            block = _wind_block(ptext)
            for sub, subtext in _split_sub_areas(block).items():
                d, lo, hi, g = _parse_wind_text(subtext)
                for z in zones:
                    results.append(
                        FwfWind(
                            z, name, sub, W.iso_z(ws), W.iso_z(we), d, lo, hi, g, subtext.strip(),
                            multi_phase=bool(_MULTI.search(subtext)),
                        )
                    )
    return results


# ------------------------------------------------------------------------ comparison


# ASSUMPTION (ours): which forecast zone and sub-area each observing station is compared with.
STATION_ZONES = {
    "camp": {
        "CIC": ("CAZ216", "all"),  # Chico airport: Sacramento Valley below 1000 ft
        "OVE": ("CAZ216", "all"),  # Oroville airport: same zone
        "JBGC1": ("CAZ266", "ridge"),  # Jarbo Gap RAWS: Sierra foothills 1000-3000 ft, ridge
        "PKCC1": ("CAZ266", "ridge"),  # Pike County Lookout RAWS
    },
    "tubbs": {
        "STS": ("CAZ506", "all"),  # Santa Rosa airport: North Bay Interior Valleys
        "RSAC1": ("CAZ506", "all"),  # Santa Rosa RAWS
        "APC": ("CAZ506", "all"),  # Napa airport
        "O69": ("CAZ506", "all"),  # Petaluma airport
        "HWKC1": ("CAZ507", "valley"),  # Hawkeye RAWS: North Bay Mountains
        "ATLC1": ("CAZ507", "ridge"),  # Atlas Peak RAWS
    },
}

EVENTS = {
    "camp": {
        "name": "Camp Fire, 2018-11-08",
        "ignition_utc": "2018-11-08T14:29:00Z",
        "wfo": "STO",
        "products_from": "2018-11-07T00:00:00Z",
        "products_to": "2018-11-09T00:00:00Z",
        "obs_from": "2018-11-07T12:00:00Z",
        "obs_to": "2018-11-09T18:00:00Z",
        "lon_lat": (-121.6, 39.81),
    },
    "tubbs": {
        "name": "Tubbs Fire, 2017-10-08/09",
        "ignition_utc": "2017-10-09T04:45:00Z",
        "wfo": "MTR",
        "products_from": "2017-10-07T00:00:00Z",
        "products_to": "2017-10-10T00:00:00Z",
        "obs_from": "2017-10-07T12:00:00Z",
        "obs_to": "2017-10-10T18:00:00Z",
        "lon_lat": (-122.64, 38.55),
    },
}


def list_products(wfo: str, pil: str, start: datetime, end: datetime, *, http_get=None, cache_dir=None):
    """[(issued_utc, product_id)] for ``pil`` (e.g. FWFSTO) issued in ``[start, end)``."""
    out = []
    day = start.replace(hour=0, minute=0, second=0, microsecond=0)
    while day < end:
        q = urllib.parse.urlencode({"cccc": f"K{wfo}", "pil": pil, "date": day.strftime("%Y-%m-%d")})
        body, _ = W.cached_get(f"{AFOS_LIST_URL}?{q}", http_get=http_get, cache_dir=cache_dir)
        for r in json.loads(body)["data"]:
            t = W.require_utc(r["entered"], "entered")
            if start <= t < end:
                out.append((t, r["product_id"]))
        day += timedelta(days=1)
    return sorted(set(out))


def fetch_product(issued: datetime, pil: str, *, http_get=None, cache_dir=None) -> tuple[str, dict]:
    """Text of the product ``pil`` entered at ``issued`` (UTC, minute precision)."""
    fmt = "%Y-%m-%dT%H:%MZ"
    q = urllib.parse.urlencode(
        {"pil": pil, "sdate": issued.strftime(fmt), "edate": (issued + timedelta(minutes=1)).strftime(fmt), "fmt": "text"}
    )
    body, rec = W.cached_get(f"{AFOS_URL}?{q}", http_get=http_get, cache_dir=cache_dir)
    return body.decode("utf-8", errors="replace"), rec


def compare(
    fc: FwfWind, series: W.WeatherSeries, issued: datetime, ignition: datetime
) -> Optional[dict]:
    """Observed wind in the forecast window versus ``fc``; None if too few observed hours."""
    ws, we = W.require_utc(fc.window_start_utc), W.require_utc(fc.window_end_utc)
    if fc.speed_hi_ms is None or fc.from_deg is None:
        return None
    hrs = [
        s for s in series.samples
        if ws <= W.require_utc(s.t_utc) < we and s.speed_ms is not None
    ]
    if len(hrs) < 6:
        return None
    mean_sp = statistics.fmean(s.speed_ms for s in hrs)
    east = sum(s.speed_ms * math.sin(math.radians(s.from_deg)) for s in hrs if s.from_deg is not None)
    north = sum(s.speed_ms * math.cos(math.radians(s.from_deg)) for s in hrs if s.from_deg is not None)
    obs_dir = W.norm_deg(math.degrees(math.atan2(east, north))) if math.hypot(east, north) > 1e-9 else None
    mid = (fc.speed_lo_ms + fc.speed_hi_ms) / 2
    gusts = [s.gust_ms for s in hrs if s.gust_ms is not None]
    in_range = sum(1 for s in hrs if fc.speed_lo_ms <= s.speed_ms <= fc.speed_hi_ms)
    return {
        "station": series.station["id"],
        "zone": fc.zone,
        "sub_area": fc.sub_area,
        "period": fc.period,
        "window_utc": [fc.window_start_utc, fc.window_end_utc],
        "lead_h": round((ws - issued).total_seconds() / 3600, 1),
        "window_contains_ignition": ws <= ignition < we,
        "n_hours": len(hrs),
        "multi_phase": fc.multi_phase,
        "dir_valid": (
            not fc.multi_phase and obs_dir is not None and mean_sp >= MIN_SPEED_FOR_DIRECTION_MS
        ),
        "fc_from_deg": fc.from_deg,
        "fc_speed_ms": [round(fc.speed_lo_ms, 2), round(fc.speed_hi_ms, 2)],
        "fc_gust_ms": None if fc.gust_ms is None else round(fc.gust_ms, 2),
        "obs_mean_speed_ms": round(mean_sp, 2),
        "obs_vector_from_deg": None if obs_dir is None else round(obs_dir),
        "obs_max_gust_ms": round(max(gusts), 2) if gusts else None,
        "dir_error_deg": None if obs_dir is None else round(W.angle_diff(obs_dir, fc.from_deg)),
        "speed_error_ms": round(mean_sp - mid, 2),
        "speed_ratio": round(mean_sp / mid, 2) if mid > 0 else None,
        "hours_in_forecast_range": round(in_range / len(hrs), 2),
        "gust_ratio": (
            round(max(gusts) / fc.gust_ms, 2) if gusts and fc.gust_ms else None
        ),
    }


def summarise(all_rows: Sequence[dict]) -> dict:
    """Error statistics. Multi-phase forecasts ("shifting to...") are excluded because only the
    first phase is parsed; direction is further limited to rows with mean wind >= 2 m/s."""
    rows = [r for r in all_rows if not r["multi_phase"]]
    d = [r["dir_error_deg"] for r in rows if r["dir_valid"]]
    s = [r["speed_error_ms"] for r in rows if r["speed_error_ms"] is not None]
    ratio = [r["speed_ratio"] for r in rows if r["speed_ratio"] is not None]
    inr = [r["hours_in_forecast_range"] for r in rows]
    g = [r["gust_ratio"] for r in rows if r["gust_ratio"] is not None]

    def q(xs, p):
        return W.percentile_nearest_rank(xs, p) if xs else None

    return {
        "n_comparisons": len(rows),
        "n_excluded_multi_phase": len(all_rows) - len(rows),
        "n_direction_comparisons": len(d),
        "dir_error_deg": {
            "mean_signed": round(statistics.fmean(d), 1) if d else None,
            "mean_abs": round(statistics.fmean(abs(x) for x in d), 1) if d else None,
            "median_abs": round(statistics.median(abs(x) for x in d), 1) if d else None,
            "p90_abs": q([abs(x) for x in d], 90),
            "max_abs": max((abs(x) for x in d), default=None),
        },
        "speed_error_ms": {
            "mean_signed": round(statistics.fmean(s), 2) if s else None,
            "mean_abs": round(statistics.fmean(abs(x) for x in s), 2) if s else None,
        },
        "speed_ratio_obs_over_forecast_mid": {
            "median": round(statistics.median(ratio), 2) if ratio else None,
            "min": min(ratio, default=None),
            "max": max(ratio, default=None),
        },
        "mean_fraction_of_hours_inside_forecast_range": round(statistics.fmean(inr), 2) if inr else None,
        "gust_ratio_obs_max_over_forecast": {
            "median": round(statistics.median(g), 2) if g else None,
            "n": len(g),
        },
    }


def run_event(key: str, *, http_get=None, cache_dir=None) -> dict:
    ev = EVENTS[key]
    ignition = W.require_utc(ev["ignition_utc"])
    cat = W.load_catalog(http_get, cache_dir)
    by_id = {s.id: s for s in cat}
    series = {}
    for sid in STATION_ZONES[key]:
        series[sid] = W.fetch_history(
            by_id[sid], W.require_utc(ev["obs_from"]), W.require_utc(ev["obs_to"]),
            http_get=http_get, cache_dir=cache_dir,
        )
    prods = list_products(
        ev["wfo"], f"FWF{ev['wfo']}", W.require_utc(ev["products_from"]),
        W.require_utc(ev["products_to"]), http_get=http_get, cache_dir=cache_dir,
    )
    rows, product_records = [], []
    for issued, pid in prods:
        text, rec = fetch_product(issued, f"FWF{ev['wfo']}", http_get=http_get, cache_dir=cache_dir)
        product_records.append({"product_id": pid, "issued_utc": W.iso_z(issued), "sha256": rec["sha256"], "bytes": rec["bytes"]})
        parsed = parse_fwf(text, issued)
        for sid, (zone, sub) in STATION_ZONES[key].items():
            for fc in parsed:
                if fc.zone == zone and fc.sub_area == sub:
                    r = compare(fc, series[sid], issued, ignition)
                    if r:
                        r["issued_utc"] = W.iso_z(issued)
                        rows.append(r)
    # Event set: periods overlapping [ignition, ignition + 24 h], forecast issued <= 12 h before
    # the period (or already in it), one row per (product, period, station).
    ign_end = ignition + timedelta(hours=24)
    ignition_rows = [
        r for r in rows
        if W.require_utc(r["window_utc"][0]) < ign_end
        and W.require_utc(r["window_utc"][1]) > ignition
        and r["lead_h"] <= 12
    ]
    return {
        "event": ev["name"],
        "ignition_utc": ev["ignition_utc"],
        "evidence_class": "observed vs archived forecast",
        "products": product_records,
        "station_zone_assumption": STATION_ZONES[key],
        "comparisons": rows,
        "summary_all_periods": summarise(rows),
        "summary_event_window": summarise(ignition_rows),
        "summary_by_station_lead_le_24h": {
            sid: summarise([r for r in rows if r["station"] == sid and r["lead_h"] <= 24])
            for sid in STATION_ZONES[key]
        },
    }


if __name__ == "__main__":  # network: writes the committed evidence file
    import sys

    out = {k: run_event(k) for k in EVENTS}
    out["pooled_event_window"] = summarise(
        [r for k in EVENTS for r in out[k]["comparisons"]
         if W.require_utc(r["window_utc"][0]) < W.require_utc(EVENTS[k]["ignition_utc"]) + timedelta(hours=24)
         and W.require_utc(r["window_utc"][1]) > W.require_utc(EVENTS[k]["ignition_utc"])
         and r["lead_h"] <= 12]
    )
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("sim/evidence/weather_forecast_error_2017_2018.json")
    target.write_text(json.dumps(out, indent=1))
    print(json.dumps({k: out[k]["summary_all_periods"] if k in EVENTS else out[k] for k in out}, indent=1))
