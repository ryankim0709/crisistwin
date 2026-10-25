"""Live herbaceous and woody fuel moisture from the Growing Season Index, as in NFDRS 2016.

Method (sources cited next to each constant and equation below):

* **GSI**, Jolly, W.M., Nemani, R. & Running, S.W. 2005, "A generalized, bioclimatic index to
  predict foliar phenology in response to climate", *Global Change Biology* 11(4):619-632: the
  daily index is the product of three indicators, each a linear ramp from 0 to 1 between two
  limits, of daily minimum temperature, vapour pressure deficit and photoperiod; the index used is
  its 21-day running mean.
* **GSI to live moisture**, the NFDRS 2016 (NFDRS4) reference implementation by W.M. Jolly
  (USFS RMRS Fire Sciences Laboratory): ``lib/NFDRS4/src/livefuelmoisture.cpp`` and
  ``lib/NFDRS4/src/nfdrs4.cpp`` in https://github.com/firelab/NFDRS4 (read at commit
  84223b95fd395a62ea344257f80a9949cee71e6e, 2026-10-16). Defaults are those of
  ``LiveFuelMoisture::Initialize``/``SetLimits``/``SetMAPeriod`` and of the repository's
  ``data/NFDRSInitSample.txt`` (``gsiUseVpdAvg = 0``, ``gsiUseRTPrecip = 0``).

The maths here is pure standard library. ``fetch_daily_inputs`` is the one network adapter: a
single Open-Meteo ERA5 daily request for the lead-in window, cached on disk through
``sim.weather.cached_get`` like the hourly weather. Design notes: ``docs/scenario-weather.md``
("Live fuel moisture from the Growing Season Index").
"""

from __future__ import annotations

import math
from collections import deque
from collections.abc import Callable, Sequence
from datetime import date, timedelta
from pathlib import Path

MODEL_VERSION = "live-gsi/1"

# --------------------------------------------------------------------------- GSI limits
# NFDRS4 LiveFuelMoisture::SetLimits defaults (= Jolly et al. 2005 Table 1 limits) and
# data/NFDRSInitSample.txt gsiTminMin/Max, gsiVpdMin/Max, gsiDayLenMin/Max.
GSI_TMIN_MIN_C = -2.0  # iTmin = 0 at or below this daily minimum temperature
GSI_TMIN_MAX_C = 5.0  # iTmin = 1 at or above
GSI_VPD_MIN_PA = 900.0  # iVPD = 1 at or below this vapour pressure deficit
GSI_VPD_MAX_PA = 4100.0  # iVPD = 0 at or above
GSI_DAYLEN_MIN_S = 36000.0  # iPhoto = 0 at or below 10 h of daylight
GSI_DAYLEN_MAX_S = 39600.0  # iPhoto = 1 at or above 11 h
GSI_AVERAGING_DAYS = 21  # running-mean window (SetMAPeriod default; gsiAveragingDays = 21)
VPD_MIN_RH_FLOOR_PCT = 5.0  # CalcGSI: CalcVPD(max(minRH, 5.0), maxTempF)

# NFDRS4 GSI -> live fuel moisture (LiveFuelMoisture::Initialize, SetLFMParameters; nfdrs4.cpp
# Init). gsiMax = 1.0, gsiHerbGreenup = 0.5.
GSI_MAX = 1.0
GSI_GREENUP_THRESHOLD = 0.5
HERB_LFM_MIN_PCT = 30.0  # SetLFMParameters(1.0, 0.5, 30, 250) for herbs
HERB_LFM_MAX_PCT = 250.0
WOODY_LFM_MIN_PCT = 60.0  # SetLFMParameters(1.0, 0.5, 60, 200) for woody fuels. NOTE: the
WOODY_LFM_MAX_PCT = 200.0  # sample init file sets woody fuelMoistureMin = "50"; the library default 60 is used.
# CalcRunningAvgHerbFM: an annual herb layer that has exceeded 120 % this year and falls below it
# can no longer increase until the herb state resets on 1 January (nfdrs4.cpp Update:
# "if (Julian < YesterdayJDay ...) HerbFM.ResetHerbState()").
ANNUAL_HERB_CURING_LOCK_PCT = 120.0
# nfdrs4.cpp Update: a gap of more than 30 days between daily updates re-initialises the model.
NFDRS_REINIT_GAP_DAYS = 30

# Daylength, MT-CLIM formula as in NFDRS4 LiveFuelMoisture::CalcDayl (livefuelmoisture.h).
RADPERDAY = 0.017214
RADPERDEG = 0.01745329
MINDECL_RAD = -0.4092797
SECPERRAD = 13750.9871
DAYSOFF = 10.25

# ASSUMPTION (no source in NFDRS4: isAnnuals is a per-station setting): whether the herbaceous
# layer of each sim/fuel_moisture.py phenology class is annual. California foothill and coastal
# grasslands are dominated by introduced annual grasses; the Colorado Front Range grassland and the
# Southern California montane herb layer are treated as perennial.
HERB_IS_ANNUAL_BY_PHENOLOGY_CLASS = {
    "ca_coastal": True,
    "ca_interior_foothill": True,
    "ca_montane": False,
    "front_range_grassland": False,
}

# ASSUMPTION: the lead-in must reach within this many days of the scenario start (ERA5 reaches the
# archive about 5 days after real time) and hold at least one full averaging window of valid days.
MAX_LEAD_GAP_DAYS = 10
MIN_VALID_DAYS = GSI_AVERAGING_DAYS

# Shown when the photoperiod alone holds an annual herb layer at its dry floor (winter). The claim
# about green-up is the known behaviour of California annual grassland after the first autumn
# rains, against which the temperate-phenology GSI is too dry; see docs/scenario-weather.md.
SHORT_DAY_HERB_WARNING = (
    "Live herb moisture from the NFDRS Growing Season Index is at its dry floor ({herb_pct:g} %) "
    "because days are short (the daylength term averaged {photo:.2f} of 1 over the last 21 days). "
    "California annual grass is usually green after the first rains, so winter spread on grass is "
    "likely overstated here."
)


def short_day_herb_floor(res: dict) -> bool:
    """True when an ``ok`` GSI result has an annual herb layer at its minimum and the window-mean
    photoperiod indicator is below the green-up threshold (so daylength alone forces the floor)."""
    photo = res.get("i_photo_window_mean")
    return bool(res.get("ok") and res.get("herb_is_annual") and photo is not None
                and res.get("herb_pct") is not None and res["herb_pct"] <= HERB_LFM_MIN_PCT
                and photo < GSI_GREENUP_THRESHOLD)


# --------------------------------------------------------------------------- daily GSI


def saturation_vapour_pressure_pa(temp_c: float) -> float:
    """NFDRS4 CalcVP: 610.7 * exp(17.38 T / (239 + T)), Pa, T in deg C."""
    return 610.7 * math.exp((17.38 * temp_c) / (239.0 + temp_c))


def daily_vpd_pa(max_temp_c: float, min_rh_pct: float) -> float:
    """NFDRS4 CalcGSI/CalcVPD default: es(Tmax) * (1 - max(RHmin, 5)/100), Pa, floored at 0."""
    rh = max(min_rh_pct, VPD_MIN_RH_FLOOR_PCT)
    vp = saturation_vapour_pressure_pa(max_temp_c)
    return max(0.0, vp - (rh / 100.0) * vp)


def daylength_s(lat_deg: float, day_of_year: int) -> float:
    """NFDRS4 CalcDayl (MT-CLIM): daylength in seconds for a latitude and day of year (1-366)."""
    lat = max(-1.5707, min(1.5707, lat_deg * RADPERDEG))
    decl = MINDECL_RAD * math.cos((day_of_year + DAYSOFF) * RADPERDAY)
    cosegeom = math.cos(lat) * math.cos(decl)
    sinegeom = math.sin(lat) * math.sin(decl)
    coshss = max(-1.0, min(1.0, -sinegeom / cosegeom))
    return 2.0 * math.acos(coshss) * SECPERRAD


def _ramp_up(x: float, lo: float, hi: float) -> float:
    return 0.0 if x < lo else 1.0 if x > hi else (x - lo) / (hi - lo)


def tmin_indicator(min_temp_c: float) -> float:
    """NFDRS4 GetTminInd (Jolly et al. 2005 eq. for iTmin)."""
    return _ramp_up(min_temp_c, GSI_TMIN_MIN_C, GSI_TMIN_MAX_C)


def vpd_indicator(vpd_pa: float) -> float:
    """NFDRS4 GetVPDInd: 1 - (VPD - min)/(max - min), clamped (Jolly et al. 2005 iVPD)."""
    return 1.0 - _ramp_up(vpd_pa, GSI_VPD_MIN_PA, GSI_VPD_MAX_PA)


def daylength_indicator(daylength_s_: float) -> float:
    """NFDRS4 GetDaylInd (Jolly et al. 2005 iPhoto)."""
    return _ramp_up(daylength_s_, GSI_DAYLEN_MIN_S, GSI_DAYLEN_MAX_S)


def daily_gsi(min_temp_c: float, max_temp_c: float, min_rh_pct: float, lat_deg: float,
              day_of_year: int) -> dict:
    """iGSI = iTmin * iVPD * iPhoto (NFDRS4 CalcGSI with m_useRTPrecip false)."""
    vpd = daily_vpd_pa(max_temp_c, min_rh_pct)
    dl = daylength_s(lat_deg, day_of_year)
    i_t, i_v, i_p = tmin_indicator(min_temp_c), vpd_indicator(vpd), daylength_indicator(dl)
    return {"gsi": i_t * i_v * i_p, "i_tmin": i_t, "i_vpd": i_v, "i_photo": i_p,
            "vpd_pa": vpd, "daylength_s": dl}


# --------------------------------------------------------------------------- GSI -> moisture


def _linear_lfm_pct(rescaled_gsi: float, min_pct: float, max_pct: float) -> float:
    """NFDRS4 SetLFMParameters: slope = (max - min)/(1 - greenup), intercept = max - slope."""
    slope = (max_pct - min_pct) / (1.0 - GSI_GREENUP_THRESHOLD)
    return slope * rescaled_gsi + (max_pct - slope)


def live_moisture_from_daily(days: Sequence[dict], lat_deg: float, herb_is_annual: bool) -> dict:
    """Run the NFDRS4 daily live-moisture update over ``days`` and return the final state.

    ``days``: chronological ``{date: datetime.date, min_temp_c, max_temp_c, min_rh_pct}``; a day
    with any value ``None`` is skipped and treated as a gap, as NFDRS4 does (``Update`` drops
    ``min(gap - 1, len(queue))`` of the oldest queued values). Snow cover (NFDRS4 ``SnowDay``) is not
    modelled (ASSUMPTION: no snow day). Returns ``{herb_pct, woody_pct, gsi, valid_days,
    last_day, window_days, herb_state}`` or ``None`` values when no day is valid.
    """
    q: deque[tuple[float, float]] = deque()  # (iGSI, iPhoto) per queued day
    last: date | None = None
    yesterday_doy = -1
    herb = {"greened": False, "can_increase": False, "exceeded120": False, "last": -1.0}
    herb_pct = woody_pct = gsi_avg = photo_avg = None
    last_daily = None
    valid = 0

    def reset_herb():
        herb.update(greened=False, can_increase=False, exceeded120=False, last=-1.0)

    for d in days:
        if None in (d.get("min_temp_c"), d.get("max_temp_c"), d.get("min_rh_pct")):
            continue
        day = d["date"]
        doy = day.timetuple().tm_yday
        if last is not None and (day - last).days > NFDRS_REINIT_GAP_DAYS:
            q.clear()  # nfdrs4.cpp Update: reinit after a gap of more than 30 days
            reset_herb()
            yesterday_doy = -1
        if doy < yesterday_doy or yesterday_doy < 0:
            reset_herb()  # nfdrs4.cpp Update: herb state resets each year (and on the first day)
        g = daily_gsi(d["min_temp_c"], d["max_temp_c"], d["min_rh_pct"], lat_deg, doy)
        if last is not None:
            gap = (day - last).days
            if gap > 1:  # LiveFuelMoisture::Update: drop extra values for a gap
                for _ in range(min(gap - 1, len(q))):
                    q.popleft()
        q.append((g["gsi"], g["i_photo"]))
        while len(q) > GSI_AVERAGING_DAYS:
            q.popleft()
        last, yesterday_doy, valid, last_daily = day, doy, valid + 1, g
        gsi_avg = sum(v[0] for v in q) / len(q)  # CalcRunningAvgGSI
        photo_avg = sum(v[1] for v in q) / len(q)
        rescale = max(0.0, min(1.0, gsi_avg / GSI_MAX))
        # CalcRunningAvgWoodyFM
        woody_pct = (_linear_lfm_pct(rescale, WOODY_LFM_MIN_PCT, WOODY_LFM_MAX_PCT)
                     if rescale >= GSI_GREENUP_THRESHOLD else WOODY_LFM_MIN_PCT)
        # CalcRunningAvgHerbFM
        ret = HERB_LFM_MIN_PCT
        if rescale >= GSI_GREENUP_THRESHOLD:
            ret = _linear_lfm_pct(rescale, HERB_LFM_MIN_PCT, HERB_LFM_MAX_PCT)
            if not herb["greened"]:
                herb["greened"] = herb["can_increase"] = True
        if not herb["can_increase"] and herb["last"] >= 0:
            ret = min(ret, herb["last"])
        if not herb["exceeded120"] and ret >= ANNUAL_HERB_CURING_LOCK_PCT:
            herb["exceeded120"] = True
        if herb["exceeded120"] and ret < ANNUAL_HERB_CURING_LOCK_PCT and herb_is_annual:
            herb["can_increase"] = False
        herb["last"] = ret
        herb_pct = ret
    return {
        "herb_pct": None if herb_pct is None else round(herb_pct, 1),
        "woody_pct": None if woody_pct is None else round(woody_pct, 1),
        "gsi": None if gsi_avg is None else round(gsi_avg, 4),
        "gsi_window_days": len(q),
        # Mean iPhoto over the same window. GSI <= iPhoto each day, so a mean below the green-up
        # threshold means daylength alone holds the GSI below green-up.
        "i_photo_window_mean": None if photo_avg is None else round(photo_avg, 4),
        "valid_days": valid,
        "last_day": None if last is None else last.isoformat(),
        "last_daily": None if last_daily is None else {k: round(v, 4) for k, v in last_daily.items()},
        "herb_state": {"greened_up_this_year": herb["greened"], "can_increase": herb["can_increase"],
                       "exceeded_120_this_year": herb["exceeded120"], "annual": herb_is_annual},
    }


def lead_in_window(scenario_local_day: date) -> tuple[date, date]:
    """Days fed to the model: from 1 January of the last lead-in day's year minus one averaging
    window (so the herb reset and a full 21-day mean are both reached) to the day before the
    scenario's local day (ASSUMPTION: only weather before the start is used)."""
    end = scenario_local_day - timedelta(days=1)
    return date(end.year, 1, 1) - timedelta(days=GSI_AVERAGING_DAYS), end


# --------------------------------------------------------------------------- daily input fetch


def daily_inputs_url(lon: float, lat: float, start_day: date, end_day: date) -> str:
    """One Open-Meteo ERA5 archive request for daily Tmin, Tmax and RHmin (local civil days)."""
    import urllib.parse

    from sim.weather import OPEN_METEO_ARCHIVE_URL, REANALYSIS_MODEL

    q = {
        "latitude": f"{lat:.4f}", "longitude": f"{lon:.4f}",
        "start_date": start_day.isoformat(), "end_date": end_day.isoformat(),
        "daily": "temperature_2m_min,temperature_2m_max,relative_humidity_2m_min",
        "models": REANALYSIS_MODEL, "temperature_unit": "celsius",
        # ASSUMPTION: local civil days stand in for NFDRS's 24 h ending at the 13:00 observation.
        "timezone": "auto",
    }
    return OPEN_METEO_ARCHIVE_URL + "?" + urllib.parse.urlencode(q)


def parse_daily_inputs(doc: dict) -> list[dict]:
    d = doc.get("daily") or {}
    times = d.get("time") or []

    def col(name, i):
        vals = d.get(name) or []
        v = vals[i] if i < len(vals) else None
        return None if v is None else float(v)

    return [{"date": date.fromisoformat(t), "min_temp_c": col("temperature_2m_min", i),
             "max_temp_c": col("temperature_2m_max", i), "min_rh_pct": col("relative_humidity_2m_min", i)}
            for i, t in enumerate(times)]


def fetch_daily_inputs(lon: float, lat: float, start_day: date, end_day: date, *,
                       http_get: Callable | None = None, cache_dir: Path | None = None) -> tuple[list[dict], dict]:
    """Daily lead-in inputs and the fetch record. Raises ``sim.weather.WeatherError``.

    Disk-cached like ``sim.weather.fetch_reanalysis``, except windows ending within
    ``REANALYSIS_LATENCY_DAYS`` of now (the archive may still be filling them in).
    """
    import hashlib
    import json
    from datetime import UTC, datetime

    from sim import weather

    url = daily_inputs_url(lon, lat, start_day, end_day)
    recent = end_day > (datetime.now(UTC) - timedelta(days=weather.REANALYSIS_LATENCY_DAYS)).date()
    if recent:
        body = (http_get or weather.default_http_get)(url)
        rec = {"url": url, "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest(),
               "retrieved_utc": weather.iso_z(datetime.now(UTC)), "from_cache": False,
               "not_cached": "window within the reanalysis latency"}
    else:
        body, rec = weather.cached_get(url, http_get=http_get, cache_dir=cache_dir)
    try:
        doc = json.loads(body)
    except ValueError as exc:
        raise weather.WeatherError(f"GSI daily inputs: unparseable answer: {exc}") from exc
    if doc.get("error"):
        raise weather.WeatherError(f"GSI daily inputs: {doc.get('reason') or doc}")
    rec = {**rec, "grid_lat": doc.get("latitude"), "grid_lon": doc.get("longitude"),
           "grid_elevation_m": doc.get("elevation"), "timezone": doc.get("timezone"),
           "source": "open_meteo_era5"}
    return parse_daily_inputs(doc), rec


def gsi_live_moisture(lon: float, lat: float, scenario_local_day: date, phenology_class: str, *,
                      http_get: Callable | None = None, cache_dir: Path | None = None) -> dict:
    """Fetch the lead-in and run the model. ``{ok, ...}``; ``ok`` False carries ``reason``."""
    from sim import weather

    start_day, end_day = lead_in_window(scenario_local_day)
    annual = HERB_IS_ANNUAL_BY_PHENOLOGY_CLASS.get(phenology_class, True)
    base = {"model_version": MODEL_VERSION, "lead_in": [start_day.isoformat(), end_day.isoformat()],
            "herb_is_annual": annual}
    try:
        days, rec = fetch_daily_inputs(lon, lat, start_day, end_day, http_get=http_get, cache_dir=cache_dir)
    except (weather.WeatherError, OSError, ValueError) as exc:
        return {**base, "ok": False, "reason": f"ERA5 daily lead-in unavailable ({exc})"}
    out = live_moisture_from_daily(days, lat, annual)
    lag = None if out["last_day"] is None else (scenario_local_day - date.fromisoformat(out["last_day"])).days
    res = {**base, **out, "fetch": rec, "lead_gap_days": lag}
    if out["valid_days"] < MIN_VALID_DAYS:
        return {**res, "ok": False, "reason": f"only {out['valid_days']} valid lead-in days "
                f"(need {MIN_VALID_DAYS})"}
    if lag is None or lag > MAX_LEAD_GAP_DAYS:
        return {**res, "ok": False, "reason": f"lead-in ends {lag} days before the start "
                f"(limit {MAX_LEAD_GAP_DAYS})"}
    return {**res, "ok": True}
