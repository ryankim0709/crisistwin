"""People and facilities data for the California scenario engine: downloaders and validators.

Two datasets feed the residents generator (`sim/` people generator) and the traffic model:

1. **Block-group vulnerability shares** (ACS 5-year, Census Bureau, public domain):
   B25044 households by tenure and vehicles available, B01001 sex by age (65 and over),
   B18101 disability status by sex and age, C16002 household language by limited English
   speaking status. Pulled for a county list or a bbox, with each block group's internal point
   from the TIGER/Line block-group file (for the bbox filter and for joining to geometry).
2. **Facilities**: licensed care facilities, hospitals and schools with coordinates and
   capacity where published (CDPH licensed and certified facility list; CDSS Community Care
   Licensing; CDE public school sites on data.ca.gov, with enrolment as the only size).

Network is used only when a subcommand runs; nothing here is imported with side effects and no
test touches the network (tests inject fake fetchers). Only the Python standard library is used.

    python3.12 -m tools.people_data census --counties 06007 --out ~/crisistwin-sources/people
    python3.12 -m tools.people_data census --bbox -122.0,39.5,-121.3,40.1 --out ...
    python3.12 -m tools.people_data facilities --counties Butte --out ~/crisistwin-sources/people
    python3.12 -m tools.people_data validate tools/people_acs_butte_fixture.json ...

Census sources. `--source api` (default) uses the Census Data API **without a key**, at low
volume (one request per table). A key is optional: set `CENSUS_API_KEY` in the environment
to use one. When the API answers with its "Missing Key" page the downloader says so and stops;
`--source bulk` then reads the same tables from the ACS table-based summary-file bulk files at
www2.census.gov (about 60-190 MB per table; streamed, stopped once past the requested
state's block groups), which needs no key at all. Both record URL, bytes and SHA-256.

De-identification: facility rows from CDSS are small residential homes (an RCFE of six beds is a
private house), so they never carry a name, street address, phone or licensee; their points are
rounded to 3 decimals (about 100 m). CDPH and CDE rows (hospitals, nursing facilities, schools)
are public institutions and keep their names; contact names, e-mail and phone are always dropped.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import os
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable, Iterator

NORMALIZER_VERSION = "people-data-1"
USER_AGENT = "crisistwin-research/0.1 (people-data downloader; low volume)"
REQUEST_PAUSE_S = 1.0  # between requests to one host

# --------------------------------------------------------------------------------------
# Census ACS 5-year
# --------------------------------------------------------------------------------------

ACS_YEAR = 2022  # 5-year 2018-2022 (2020 block groups); the table-based summary file exists from 2021
STATE_FIPS = "06"
CENSUS_API = "https://api.census.gov/data/{year}/acs/acs5"
BULK_URL = ("https://www2.census.gov/programs-surveys/acs/summary_file/{year}/table-based-SF/"
            "data/5YRData/acsdt5y{year}-{table}.dat")
TIGER_BG_URL = "https://www2.census.gov/geo/tiger/TIGER{year}/BG/tl_{year}_{state}_bg.zip"
CENSUS_LICENCE = ("US Census Bureau data are US government works (public domain, Title 17 USC 105); "
                  "cite 'U.S. Census Bureau, American Community Survey 5-Year Estimates'.")

# Table -> cells (suffix numbers within the table) that the extract needs.
TABLE_CELLS: dict[str, tuple[int, ...]] = {
    "B25044": (1, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15),
    "B01001": (1, *range(20, 26), *range(44, 50)),
    "B18101": (1, 4, 7, 10, 13, 16, 19, 23, 26, 29, 32, 35, 38, 15, 18, 34, 37),
    "C16002": (1, 4, 7, 10, 13),
}
# Lowest geography each table is published at in the ACS 5-year. B18101 (disability) has no block-group rows
# (checked in the bulk file: none), so a block group inherits its tract's counts and the extract says so.
TABLE_GEO = {"B25044": "block group", "B01001": "block group", "B18101": "tract", "C16002": "block group"}
GEO_PREFIX = {"block group": f"1500000US{STATE_FIPS}", "tract": f"1400000US{STATE_FIPS}"}
TABLE_TITLES = {
    "B25044": "Tenure by vehicles available (households)",
    "B01001": "Sex by age (total population)",
    "B18101": "Sex by age by disability status (civilian noninstitutionalized population)",
    "C16002": "Household language by household limited English speaking status (households)",
}

# Derived field -> (table, cells summed). Cell numbers as in the Census variable list.
DERIVED: dict[str, tuple[str, tuple[int, ...]]] = {
    "households": ("B25044", (1,)),
    "hh_no_vehicle": ("B25044", (3, 10)),
    "hh_1_vehicle": ("B25044", (4, 11)),
    "hh_2_vehicle": ("B25044", (5, 12)),
    "hh_3plus_vehicle": ("B25044", (6, 7, 8, 13, 14, 15)),
    "pop": ("B01001", (1,)),
    "pop_65plus": ("B01001", (*range(20, 26), *range(44, 50))),
    "disab_universe": ("B18101", (1,)),
    "disab_total": ("B18101", (4, 7, 10, 13, 16, 19, 23, 26, 29, 32, 35, 38)),
    "disab_65plus": ("B18101", (16, 19, 35, 38)),
    "disab_65plus_universe": ("B18101", (15, 18, 34, 37)),
    "lep_universe": ("C16002", (1,)),
    "lep_households": ("C16002", (4, 7, 10, 13)),
}
MOE_FIELDS = ("hh_no_vehicle", "pop_65plus", "disab_total", "lep_households")  # headline shares carry a 90% MOE
COUNT_FIELDS = tuple(DERIVED)


class SourceError(RuntimeError):
    """A source answered with something other than the expected data."""


Fetcher = Callable[[str], bytes]


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class _DefaultPortRedirect(urllib.request.HTTPRedirectHandler):
    """Drop an explicit default port from redirect targets: data.chhs.ca.gov redirects to a presigned
    S3 URL written with ':443', and the signature fails when urllib sends 'Host: s3.amazonaws.com:443'."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return super().redirect_request(req, fp, code, msg, headers, newurl.replace(":443/", "/", 1))


def http_get(url: str, *, retries: int = 2, timeout: float = 120.0) -> bytes:
    """GET with a descriptive User-Agent and a short retry. Network use starts here only."""
    last: Exception | None = None
    opener = urllib.request.build_opener(_DefaultPortRedirect)
    for attempt in range(retries + 1):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with opener.open(request, timeout=timeout) as response:
                return response.read()
        except (urllib.error.URLError, TimeoutError) as err:
            last = err
            time.sleep(2.0 * (attempt + 1))
    raise SourceError(f"GET failed for {url}: {last}")


class Recorder:
    """Wraps a fetcher and records url, byte size and SHA-256 of every response."""

    def __init__(self, fetch: Fetcher, pause_s: float = 0.0):
        self.fetch, self.pause_s, self.sources = fetch, pause_s, []

    def get(self, url: str, **extra) -> bytes:
        if self.sources and self.pause_s:
            time.sleep(self.pause_s)
        data = self.fetch(url)
        self.sources.append({"url": url, "bytes": len(data), "sha256": sha256_hex(data),
                             "retrieved_at": utc_now(), **extra})
        return data


# ---- cell parsing -------------------------------------------------------------------

def parse_estimate(text: str | int | float | None) -> int | None:
    """ACS estimate or margin: None for blank, annotation or Census sentinel (<= -222222222)."""
    if text is None:
        return None
    s = str(text).strip()
    if s in ("", "null", "None"):
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    if v <= -222222222 or not math.isfinite(v):
        return None
    return int(round(v))


def _sum(cells: dict[str, int | None], table: str, numbers: Iterable[int], kind: str) -> int | None:
    total = 0
    for n in numbers:
        v = cells.get(f"{table}_{kind}{n:03d}")
        if v is None:
            return None
        total += v
    return total


def _moe_sum(cells: dict[str, int | None], table: str, numbers: Iterable[int]) -> int | None:
    sq = 0.0
    for n in numbers:
        v = cells.get(f"{table}_M{n:03d}")
        if v is None:
            return None
        sq += v * v
    return int(round(math.sqrt(sq)))


def derive_record(geoid: str, cells: dict[str, int | None]) -> dict:
    """One block group record from normalised cells ('B25044_E003' -> value, '..._M003' -> margin)."""
    rec: dict = {"geoid": geoid}
    for name, (table, numbers) in DERIVED.items():
        rec[name] = _sum(cells, table, numbers, "E")
    rec["moe90"] = {name: _moe_sum(cells, *DERIVED[name]) for name in MOE_FIELDS}
    return rec


def shares(rec: dict) -> dict[str, float | None]:
    """Shares used by the generator. None where the denominator is zero or missing."""
    def ratio(a: str, b: str) -> float | None:
        x, y = rec.get(a), rec.get(b)
        return None if x is None or not y else round(x / y, 4)
    return {
        "no_vehicle": ratio("hh_no_vehicle", "households"),
        "age_65plus": ratio("pop_65plus", "pop"),
        "disability": ratio("disab_total", "disab_universe"),
        "disability_65plus": ratio("disab_65plus", "disab_65plus_universe"),
        "limited_english": ratio("lep_households", "lep_universe"),
    }


# ---- Data API source ----------------------------------------------------------------

def api_url(year: int, table: str, county: str, key: str | None) -> str:
    """Census API URL for one table, all block groups of one county (FIPS3), keyless unless key."""
    variables = ",".join(f"{table}_{n:03d}{k}" for n in TABLE_CELLS[table] for k in ("E", "M"))
    query = [("get", "NAME," + variables), ("for", TABLE_GEO[table] + ":*"), ("in", f"state:{STATE_FIPS} county:{county}")]
    if key:
        query.append(("key", key))
    return CENSUS_API.format(year=year) + "?" + urllib.parse.urlencode(query, quote_via=urllib.parse.quote, safe=":*,")


def parse_api_table(table: str, body: bytes) -> dict[str, dict[str, int | None]]:
    """geoid -> normalised cells from one Census API JSON response."""
    head = body[:200].lstrip().lower()
    if head.startswith(b"<") or b"missing key" in body[:2000].lower():
        raise SourceError("Census API refused the request (the 'Missing Key' page): keyless use is not "
                          "accepted from this address now (quota or policy); set CENSUS_API_KEY or use --source bulk")
    try:
        rows = json.loads(body)
    except ValueError as err:
        raise SourceError(f"Census API returned non-JSON for {table}: {err}") from err
    header, data = rows[0], rows[1:]
    idx = {name: i for i, name in enumerate(header)}
    out: dict[str, dict[str, int | None]] = {}
    for row in data:
        geoid = row[idx["state"]] + row[idx["county"]] + row[idx["tract"]] + (
            row[idx["block group"]] if "block group" in idx else "")
        cells = {}
        for name, i in idx.items():
            if name.startswith(table + "_"):
                var = name[len(table) + 1:]  # '003E' / '003M'
                cells[f"{table}_{var[-1]}{var[:3]}"] = parse_estimate(row[i])
        out[geoid] = cells
    return out


# ---- Bulk summary-file source -------------------------------------------------------

def parse_bulk_lines(table: str, lines: Iterator[str], geo_prefix: str) -> tuple[dict[str, dict[str, int | None]], bool]:
    """Read pipe-delimited lines (header first); keep GEO_IDs starting with geo_prefix.

    Rows are sorted by GEO_ID, so reading stops at the first row after the prefix run. Returns
    (rows, stopped_early).
    """
    header = next(lines).rstrip("\n").split("|")
    col = {name: i for i, name in enumerate(header)}
    wanted = {f"{table}_{k}{n:03d}": f"{table}_{k}{n:03d}" for n in TABLE_CELLS[table] for k in ("E", "M")}
    out: dict[str, dict[str, int | None]] = {}
    seen = False
    for line in lines:
        fields = line.rstrip("\n").split("|")
        gid = fields[0]
        if gid.startswith(geo_prefix):
            seen = True
            # file columns are 'B25044_E003' (E/M then number), the same shape as the normalised keys
            out[gid.split("US", 1)[1]] = {k: parse_estimate(fields[col[k]]) for k in wanted if k in col}
        elif seen:
            return out, True
    return out, False


def stream_bulk(url: str, geo_prefix: str, table: str) -> tuple[dict, dict]:
    """Stream a bulk file with an early stop. Returns (rows, source record)."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    digest = hashlib.sha256()
    read = 0

    class Tee(io.RawIOBase):
        def __init__(self, raw):
            self.raw = raw

        def readable(self):
            return True

        def readinto(self, b):
            nonlocal read
            n = self.raw.readinto(b)
            if n:
                digest.update(bytes(b[:n]))
                read += n
            return n

    with urllib.request.urlopen(request, timeout=300) as response:
        total = response.headers.get("Content-Length")
        text = io.TextIOWrapper(io.BufferedReader(Tee(response), buffer_size=1 << 20), encoding="utf-8", newline="\n")
        rows, early = parse_bulk_lines(table, iter(text), geo_prefix)
    return rows, {"url": url, "bytes_read": read, "bytes_total": int(total) if total else None,
                  "sha256_of_bytes_read": digest.hexdigest(), "stopped_early": early, "retrieved_at": utc_now()}


# ---- TIGER/Line block-group internal points -----------------------------------------

def read_dbf(data: bytes) -> list[dict[str, str]]:
    """Minimal dBase III reader (character and numeric fields), enough for TIGER/Line .dbf."""
    n_records, header_len, record_len = struct.unpack("<IHH", data[4:12])
    fields, pos = [], 32
    while data[pos] != 0x0D:
        name = data[pos:pos + 11].split(b"\x00")[0].decode("ascii")
        fields.append((name, data[pos + 16]))
        pos += 32
    rows = []
    for i in range(n_records):
        start = header_len + i * record_len
        rec, off = {}, start + 1
        for name, length in fields:
            rec[name] = data[off:off + length].decode("latin-1").strip()
            off += length
        rows.append(rec)
    return rows


def parse_tiger_bg_zip(blob: bytes) -> dict[str, dict]:
    """geoid -> {county, lat, lon} from tl_YYYY_SS_bg.zip (INTPTLAT/INTPTLON are the internal point)."""
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        name = next(n for n in z.namelist() if n.lower().endswith(".dbf"))
        rows = read_dbf(z.read(name))
    return {r["GEOID"]: {"county": r["COUNTYFP"], "lat": float(r["INTPTLAT"]), "lon": float(r["INTPTLON"])}
            for r in rows}


def select_block_groups(points: dict[str, dict], counties: list[str] | None,
                        bbox: tuple[float, float, float, float] | None) -> dict[str, dict]:
    """Block groups in the county list (FIPS3) and/or whose internal point lies in bbox (w,s,e,n)."""
    out = {}
    for geoid, p in points.items():
        if counties and p["county"] not in counties:
            continue
        if bbox and not (bbox[0] <= p["lon"] <= bbox[2] and bbox[1] <= p["lat"] <= bbox[3]):
            continue
        out[geoid] = p
    return out


def build_census_extract(selected: dict[str, dict], tables: dict[str, dict[str, dict[str, int | None]]],
                         sources: list[dict], year: int, notes: dict) -> dict:
    """Join the four tables to the selected block groups into one extract with provenance."""
    records = []
    for geoid in sorted(selected):
        cells: dict[str, int | None] = {}
        for table in TABLE_CELLS:
            key = geoid if TABLE_GEO[table] == "block group" else geoid[:11]  # tract-level tables: parent tract
            cells.update(tables[table].get(key, {}))
        rec = derive_record(geoid, cells)
        rec["lat"], rec["lon"] = round(selected[geoid]["lat"], 5), round(selected[geoid]["lon"], 5)
        records.append(rec)
    return {
        "dataset": f"ACS {year} 5-year block-group vulnerability counts (observed, Census Bureau)",
        "normalizer": NORMALIZER_VERSION,
        "evidence_class": "observed",
        "vintage": f"ACS {year - 4}-{year} 5-year estimates; {year} TIGER/Line block groups",
        "licence": CENSUS_LICENCE,
        "tables": TABLE_TITLES,
        "universe_notes": {
            "households": "occupied housing units (B25044, C16002)",
            "pop": "total population (B01001)",
            "disab_universe": "civilian noninstitutionalized population with disability status determined (B18101)",
            "disab_*": "TRACT-level counts repeated on every block group of the tract (B18101 is not published for "
                       "block groups); use only the shares (disability, disability_65plus), never sum these counts "
                       "across block groups",
        },
        "table_geography": TABLE_GEO,
        "derived_fields": {k: f"{t}: sum of cells {list(n)}" for k, (t, n) in DERIVED.items()},
        "moe90": "90% margin of error of the sum (root sum of squares of cell margins); block-group estimates are noisy",
        "coordinate_order": "lon, lat (EPSG:4326)",
        "coordinate_note": "lat/lon are the TIGER/Line internal point of the block group, not a centroid of residents",
        "sources": sources,
        "notes": notes,
        "records": records,
    }


def run_census(counties: list[str] | None, bbox: tuple[float, float, float, float] | None, *, year: int = ACS_YEAR,
               source: str = "api", key: str | None = None, fetch: Fetcher = http_get,
               stream: Callable[[str, str, str], tuple[dict, dict]] = stream_bulk) -> dict:
    """Download and assemble the extract. `fetch`/`stream` are injectable so tests never use the network."""
    if not counties and not bbox:
        raise SourceError("give --counties and/or --bbox")
    rec = Recorder(fetch, REQUEST_PAUSE_S)
    tiger_url = TIGER_BG_URL.format(year=year, state=STATE_FIPS)
    points = parse_tiger_bg_zip(rec.get(tiger_url, role="block-group internal points"))
    selected = select_block_groups(points, counties, bbox)
    if not selected:
        raise SourceError("no block groups match the county list / bbox")
    county_list = sorted({p["county"] for p in selected.values()})
    tables: dict[str, dict] = {}
    if source == "api":
        for table in TABLE_CELLS:
            merged: dict = {}
            for county in county_list:
                merged.update(parse_api_table(table, rec.get(api_url(year, table, county, key), table=table)))
            tables[table] = merged
    elif source == "bulk":
        for table in TABLE_CELLS:
            rows, info = stream(BULK_URL.format(year=year, table=table.lower()), GEO_PREFIX[TABLE_GEO[table]], table)
            rec.sources.append({**info, "table": table})
            tables[table] = rows
    else:
        raise SourceError(f"unknown source {source!r}")
    missing = [g for g in selected if g not in tables["B25044"]]
    notes = {"source": source, "keyless": key is None and source == "api", "county_fips": county_list,
             "bbox_w_s_e_n": list(bbox) if bbox else None, "block_groups_selected": len(selected),
             "block_groups_missing_from_acs": len(missing)}
    return build_census_extract(selected, tables, rec.sources, year, notes)


# --------------------------------------------------------------------------------------
# Facilities
# --------------------------------------------------------------------------------------

CDPH_URL = ("https://data.chhs.ca.gov/dataset/3b5b80e8-6b8d-4715-b3c0-2699af6e72e5/resource/"
            "f0ae5731-fef8-417f-839d-54a0ed3a126e/download/health_facility_locations.csv")
CDPH_PAGE = "https://data.chhs.ca.gov/dataset/healthcare-facility-locations"
CCL_LAYER = "https://services.arcgis.com/XLPEppdz2H9dOiqp/arcgis/rest/services/CDSS_CCL_Facilities/FeatureServer/0"
CCL_PAGE = "https://data.chhs.ca.gov/dataset/community-care-licensing-facilities"
CDE_LAYER = "https://services3.arcgis.com/fdvHcZVgB2QSRNkL/arcgis/rest/services/SchoolSites2526/FeatureServer/0"
CDE_PAGE = "https://data.ca.gov/dataset/california-public-schools-2025-26"
# The CDE school directory text file (cde.ca.gov/schooldirectory/report?rid=dl1&tp=txt) sits behind a bot wall that
# blocks repeat automated downloads (Radware captcha), so the CDE school-site layer on data.ca.gov is used instead.

FACILITY_LICENCES = {
    "cdph": {"publisher": "California Department of Public Health, Center for Health Care Quality (ELMS)",
             "page": CDPH_PAGE, "url": CDPH_URL,
             "licence": "data.chhs.ca.gov dataset field data_license = 'Terms of Use' (no SPDX/Creative Commons "
                        "licence; the portal's terms permit public use with attribution to CDPH)",
             "licence_checked": "package_show API of data.chhs.ca.gov, 2026-10-24"},
    "cdss": {"publisher": "California Department of Social Services, Community Care Licensing Division",
             "page": CCL_PAGE, "url": CCL_LAYER,
             "licence": "data.chhs.ca.gov dataset field data_license = 'Terms of Use' (no SPDX/Creative Commons "
                        "licence; the portal's terms permit public use with attribution to CDSS)",
             "licence_checked": "package_show API of data.chhs.ca.gov, 2026-10-24"},
    "cde": {"publisher": "California Department of Education, California School Directory",
            "page": CDE_PAGE, "url": CDE_LAYER,
            "licence": "no licence stated: the data.ca.gov dataset and the ArcGIS item (accessInformation 'California "
                       "Department of Education (CDE), United States Census Bureau') carry no licence or terms text. "
                       "Public data of a state agency; CDE says directory fields are self-reported by LEAs. Treated as a "
                       "public record; confirm with CDE before redistributing beyond this repository",
            "licence_checked": "data.ca.gov package_show and ArcGIS item JSON, 2026-10-24 (licence fields empty)"},
}

# CDPH FAC_FDR (facility type) -> kind
CDPH_KINDS = {
    "SKILLED NURSING FACILITY": "skilled_nursing",
    "INTERMEDIATE CARE FACILITY": "intermediate_care",
    "INTERMEDIATE CARE FACILITY-DD/H/N/CN/IID": "intermediate_care",
    "GENERAL ACUTE CARE HOSPITAL": "hospital",
    "ACUTE PSYCHIATRIC HOSPITAL": "hospital_psychiatric",
    "ADULT DAY HEALTH CARE": "adult_day_health",
    "CONGREGATE LIVING HEALTH FACILITY": "congregate_living_health",
    "HOSPICE FACILITY": "hospice_facility",
}
# CDSS TYPE code -> kind (codes read from the live layer: 740 'RESIDENTIAL-ELDERLY', 735 'ADULT RESIDENTIAL', ...)
CCL_KINDS = {
    740: "rcfe",
    735: "adult_residential",
    775: "adult_day_care",
    850: "child_care_center",
    830: "child_care_center",
    840: "child_care_center",
    860: "child_care_center",
}
CCL_STATUS_KEEP = (3,)  # modal status in Butte (almost all rows); meaning of codes not published in the layer (ASSUMPTION)
CCL_FIELDS = "FAC_NBR,TYPE,STATUS,CAPACITY,FAC_LATITUDE,FAC_LONGITUDE,FAC_CO_NBR,COUNTY,RES_CITY,RES_ZIP_CODE,FAC_TYPE_DESC"
# CCLD county numbers are the alphabetical order of California's 58 counties (Butte = 4 verified on the live layer).
CA_COUNTIES = tuple(
    "Alameda,Alpine,Amador,Butte,Calaveras,Colusa,Contra Costa,Del Norte,El Dorado,Fresno,Glenn,Humboldt,Imperial,"
    "Inyo,Kern,Kings,Lake,Lassen,Los Angeles,Madera,Marin,Mariposa,Mendocino,Merced,Modoc,Mono,Monterey,Napa,Nevada,"
    "Orange,Placer,Plumas,Riverside,Sacramento,San Benito,San Bernardino,San Diego,San Francisco,San Joaquin,"
    "San Luis Obispo,San Mateo,Santa Barbara,Santa Clara,Santa Cruz,Shasta,Sierra,Siskiyou,Solano,Sonoma,Stanislaus,"
    "Sutter,Tehama,Trinity,Tulare,Tuolumne,Ventura,Yolo,Yuba".split(",")
)

CA_BBOX = (-124.6, 32.4, -114.0, 42.1)  # w, s, e, n (generous California bounds)
SCHOOL_STATUS_KEEP = ("Active",)
CDE_FIELDS = "CDSCode,SchoolName,Status,City,Zip,GradeLow,GradeHigh,EnrollTotal,Latitude,Longitude,CountyName,Year"
FORBIDDEN_KEYS = {"address", "street", "phone", "email", "licensee", "administrator", "fax", "contact"}


def _num(text: str | None) -> float | None:
    try:
        v = float((text or "").strip())
    except ValueError:
        return None
    return v if math.isfinite(v) else None


def _int(text: str | None) -> int | None:
    v = _num(text)
    return None if v is None or v < 0 else int(v)


def county_number(name: str) -> int:
    lower = [c.lower() for c in CA_COUNTIES]
    try:
        return lower.index(name.strip().lower()) + 1
    except ValueError as err:
        raise SourceError(f"unknown California county {name!r}") from err


def parse_cdph(csv_text: str, counties: list[str]) -> list[dict]:
    """Hospitals, nursing and care facilities from the CDPH list. Capacity = licensed beds as published."""
    wanted = {c.upper() for c in counties}
    out = []
    for row in csv.DictReader(io.StringIO(csv_text)):
        if row.get("COUNTY_NAME", "").upper() not in wanted or row.get("FAC_STATUS_TYPE_CODE") != "OPEN":
            continue
        kind = CDPH_KINDS.get(row.get("FAC_FDR", ""))
        lat, lon = _num(row.get("LATITUDE")), _num(row.get("LONGITUDE"))
        if not kind or lat is None or lon is None:
            continue
        out.append({
            "id": "cdph:" + row["FACID"], "source": "cdph", "kind": kind, "name": row["FACNAME"].title(),
            "city": row["CITY"].title(), "zip": row["ZIP"], "lat": round(lat, 5), "lon": round(lon, 5),
            "capacity": _int(row.get("CAPACITY")), "capacity_unit": "licensed beds (0 = not a bed-based licence)",
            "licence_status": row.get("LICENSE_STATUS_DESCRIPTION") or None, "data_date": row.get("DATA_DATE") or None,
        })
    return sorted(out, key=lambda r: r["id"])


def ccl_query_url(county_no: int, offset: int) -> str:
    query = [("where", f"FAC_CO_NBR={county_no}"), ("outFields", CCL_FIELDS), ("returnGeometry", "false"),
             ("orderByFields", "FAC_NBR"), ("resultOffset", str(offset)), ("resultRecordCount", "1000"), ("f", "json")]
    return CCL_LAYER + "/query?" + urllib.parse.urlencode(query)


def parse_ccl(features: list[dict]) -> list[dict]:
    """Elder, adult and child care from CDSS. De-identified: no name, address, phone; points to 3 decimals."""
    out = []
    for feat in features:
        a = feat.get("attributes", {})
        kind = CCL_KINDS.get(a.get("TYPE"))
        lat, lon = _num(a.get("FAC_LATITUDE")), _num(a.get("FAC_LONGITUDE"))
        if not kind or a.get("STATUS") not in CCL_STATUS_KEEP or lat is None or lon is None:
            continue
        cap = a.get("CAPACITY")
        out.append({
            "id": f"cdss:{a['FAC_NBR']}", "source": "cdss", "kind": kind, "name": None,
            "city": (a.get("RES_CITY") or "").strip().title(), "zip": str(a.get("RES_ZIP_CODE") or "")[:5],
            "lat": round(lat, 3), "lon": round(lon, 3),
            "capacity": cap if isinstance(cap, int) and cap >= 0 else None, "capacity_unit": "licensed clients",
            "licence_status": f"CDSS status code {a.get('STATUS')}", "data_date": None,
        })
    return sorted(out, key=lambda r: r["id"])


def cde_query_url(county: str, offset: int) -> str:
    where = "CountyName='" + county.replace("'", "''") + "'"
    query = [("where", where), ("outFields", CDE_FIELDS), ("returnGeometry", "false"),
             ("orderByFields", "CDSCode"), ("resultOffset", str(offset)), ("resultRecordCount", "1000"), ("f", "json")]
    return CDE_LAYER + "/query?" + urllib.parse.urlencode(query)


def parse_cde(features: list[dict]) -> list[dict]:
    """Active TK-12 public schools from the CDE school-site layer (district offices are excluded by CDE).

    `capacity` holds Fall census-day enrollment of the layer's school year, a proxy: building capacity is
    not published. No staff or administrator fields are requested.
    """
    out = []
    for feat in features:
        a = feat.get("attributes", {})
        lat, lon = _num(str(a.get("Latitude", ""))), _num(str(a.get("Longitude", "")))
        if a.get("Status") not in SCHOOL_STATUS_KEEP or lat is None or lon is None or not a.get("CDSCode"):
            continue
        enroll = a.get("EnrollTotal")
        out.append({
            "id": "cde:" + str(a["CDSCode"]), "source": "cde", "kind": "school", "name": a.get("SchoolName"),
            "city": (a.get("City") or "").title(), "zip": str(a.get("Zip") or "")[:5],
            "lat": round(lat, 5), "lon": round(lon, 5),
            "capacity": enroll if isinstance(enroll, int) and enroll >= 0 else None,
            "capacity_unit": f"enrolled students, Fall census day {a.get('Year')} (not building capacity)",
            "grades": f"{a.get('GradeLow')}-{a.get('GradeHigh')}", "licence_status": None, "data_date": a.get("Year"),
        })
    return sorted(out, key=lambda r: r["id"])


def run_facilities(counties: list[str], *, fetch: Fetcher = http_get) -> dict:
    """Download CDPH, CDSS and CDE records for the counties and return one extract with licences."""
    rec = Recorder(fetch, REQUEST_PAUSE_S)
    rows: list[dict] = []
    rows += parse_cdph(rec.get(CDPH_URL, dataset="cdph").decode("utf-8-sig"), counties)
    for county in counties:
        no, offset = county_number(county), 0
        while True:
            body = json.loads(rec.get(ccl_query_url(no, offset), dataset="cdss"))
            if "error" in body:
                raise SourceError(f"CDSS layer error: {body['error']}")
            feats = body.get("features", [])
            rows += parse_ccl([f for f in feats if (f["attributes"].get("COUNTY") or "").startswith(county)
                               or f["attributes"].get("COUNTY") is None])
            if not body.get("exceededTransferLimit") or not feats:
                break
            offset += len(feats)
    for county in counties:
        offset = 0
        while True:
            body = json.loads(rec.get(cde_query_url(county, offset), dataset="cde"))
            if "error" in body:
                raise SourceError(f"CDE layer error: {body['error']}")
            feats = body.get("features", [])
            rows += parse_cde(feats)
            if not body.get("exceededTransferLimit") or not feats:
                break
            offset += len(feats)
    return build_facility_extract(rows, rec.sources, counties)


def build_facility_extract(rows: list[dict], sources: list[dict], counties: list[str]) -> dict:
    by_kind: dict[str, int] = {}
    for r in rows:
        by_kind[r["kind"]] = by_kind.get(r["kind"], 0) + 1
    return {
        "dataset": "Licensed care facilities, hospitals and public schools (observed, state licensing and directory data)",
        "normalizer": NORMALIZER_VERSION,
        "evidence_class": "observed",
        "snapshot_note": "current registry snapshot, not the 2018 roster: closures and openings since 2018 are not reflected",
        "licences": FACILITY_LICENCES,
        "coordinate_order": "lon, lat (EPSG:4326)",
        "coordinate_precision": "CDSS rows 3 decimals (about 100 m); CDPH and CDE rows 5 decimals (public institutions)",
        "de_identification": "CDSS rows carry no name, street address, phone or licensee (small homes are private "
                             "residences); CDPH contact names, e-mail and phone are dropped; CDE administrator names dropped",
        "capacity_note": "capacity is the published licensed capacity (beds or clients); for schools it is enrolment "
                         "(a proxy, not building capacity); 0 in CDPH means not a bed-based licence",
        "counties": counties,
        "counts_by_kind": dict(sorted(by_kind.items())),
        "sources": sources,
        "facilities": rows,
    }


# --------------------------------------------------------------------------------------
# Validation (used by tests and by the validate subcommand)
# --------------------------------------------------------------------------------------

def validate_census_extract(doc: dict, bbox: tuple[float, float, float, float] = CA_BBOX) -> list[str]:
    """Return a list of problems (empty when the extract is consistent)."""
    problems: list[str] = []
    for key in ("licence", "sources", "records", "vintage", "evidence_class"):
        if not doc.get(key):
            problems.append(f"missing {key}")
    for s in doc.get("sources", []):
        if not s.get("url") or not (s.get("sha256") or s.get("sha256_of_bytes_read")):
            problems.append(f"source without url/sha256: {s.get('url')}")
    seen = set()
    for r in doc.get("records", []):
        g = r.get("geoid", "")
        if len(g) != 12 or not g.isdigit() or not g.startswith(STATE_FIPS):
            problems.append(f"bad geoid {g!r}")
        if g in seen:
            problems.append(f"duplicate geoid {g}")
        seen.add(g)
        for f in COUNT_FIELDS:
            v = r.get(f)
            if v is not None and (not isinstance(v, int) or v < 0):
                problems.append(f"{g}: {f} must be a non-negative integer, got {v!r}")
        pairs = [("hh_no_vehicle", "households"), ("pop_65plus", "pop"), ("disab_total", "disab_universe"),
                 ("lep_households", "lep_universe"), ("disab_65plus", "disab_65plus_universe"),
                 ("disab_65plus", "disab_total"), ("disab_65plus_universe", "disab_universe")]
        for part, whole in pairs:
            if r.get(part) is not None and r.get(whole) is not None and r[part] > r[whole]:
                problems.append(f"{g}: {part} {r[part]} exceeds {whole} {r[whole]}")
        veh = [r.get(k) for k in ("hh_no_vehicle", "hh_1_vehicle", "hh_2_vehicle", "hh_3plus_vehicle")]
        if None not in veh and r.get("households") is not None and sum(veh) != r["households"]:
            problems.append(f"{g}: vehicle classes sum {sum(veh)} != households {r['households']}")
        lat, lon = r.get("lat"), r.get("lon")
        if lat is None or lon is None or not (bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]):
            problems.append(f"{g}: point outside bounds ({lat}, {lon})")
    return problems


def validate_facilities(doc: dict, bbox: tuple[float, float, float, float] = CA_BBOX) -> list[str]:
    problems: list[str] = []
    for src in ("cdph", "cdss", "cde"):
        lic = doc.get("licences", {}).get(src, {})
        if not lic.get("licence") or not lic.get("url") or not lic.get("page"):
            problems.append(f"licence record incomplete for {src}")
    if not doc.get("sources"):
        problems.append("no recorded source downloads")
    for s in doc.get("sources", []):
        if not s.get("url") or not s.get("sha256") or not s.get("bytes"):
            problems.append(f"source without url/bytes/sha256: {s.get('url')}")
    seen = set()
    for f in doc.get("facilities", []):
        fid = f.get("id")
        if fid in seen:
            problems.append(f"duplicate id {fid}")
        seen.add(fid)
        if f.get("source") not in ("cdph", "cdss", "cde"):
            problems.append(f"{fid}: unknown source")
        if f.get("capacity") is not None and (not isinstance(f["capacity"], int) or f["capacity"] < 0):
            problems.append(f"{fid}: capacity must be a non-negative integer or null")
        if not (bbox[0] <= f.get("lon", 0) <= bbox[2] and bbox[1] <= f.get("lat", 0) <= bbox[3]):
            problems.append(f"{fid}: point outside bounds")
        bad = FORBIDDEN_KEYS & {k.lower() for k in f}
        if bad:
            problems.append(f"{fid}: identifying keys {sorted(bad)}")
        if f.get("source") == "cdss":
            if f.get("name") is not None:
                problems.append(f"{fid}: cdss rows must not carry a name")
            for k in ("lat", "lon"):
                if round(f[k], 3) != f[k]:
                    problems.append(f"{fid}: cdss {k} not rounded to 3 decimals")
    return problems


# --------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------

def _parse_bbox(text: str) -> tuple[float, float, float, float]:
    w, s, e, n = (float(x) for x in text.split(","))
    if not (w < e and s < n):
        raise SystemExit("--bbox must be west,south,east,north with west<east and south<north")
    return w, s, e, n


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("census", help="ACS block-group vulnerability extract")
    c.add_argument("--counties", default="", help="comma-separated county FIPS3 codes within California, e.g. 007")
    c.add_argument("--bbox", help="west,south,east,north")
    c.add_argument("--year", type=int, default=ACS_YEAR)
    c.add_argument("--source", choices=("api", "bulk"), default="api")
    c.add_argument("--out", type=Path, required=True, help="output directory")
    f = sub.add_parser("facilities", help="licensed facilities, hospitals and schools")
    f.add_argument("--counties", required=True, help="comma-separated county names, e.g. Butte")
    f.add_argument("--out", type=Path, required=True)
    v = sub.add_parser("validate", help="validate extract files")
    v.add_argument("files", nargs="+", type=Path)
    args = ap.parse_args(argv)

    if args.cmd == "validate":
        bad = 0
        for p in args.files:
            doc = json.loads(p.read_text())
            probs = validate_census_extract(doc) if "records" in doc else validate_facilities(doc)
            print(f"{p}: {'OK' if not probs else str(len(probs)) + ' problem(s)'}")
            for line in probs[:20]:
                print("  -", line)
            bad += bool(probs)
        return 1 if bad else 0

    args.out.mkdir(parents=True, exist_ok=True)
    if args.cmd == "census":
        counties = [x.strip().zfill(3)[-3:] for x in args.counties.split(",") if x.strip()]
        doc = run_census(counties or None, _parse_bbox(args.bbox) if args.bbox else None, year=args.year,
                         source=args.source, key=os.environ.get("CENSUS_API_KEY") or None)
        problems = validate_census_extract(doc)
        path = args.out / f"people_acs_{args.year}_{'-'.join(counties) or 'bbox'}.json"
    else:
        counties = [x.strip() for x in args.counties.split(",") if x.strip()]
        doc = run_facilities(counties)
        problems = validate_facilities(doc)
        path = args.out / f"people_facilities_{'-'.join(c.lower() for c in counties)}.json"
    path.write_text(json.dumps(doc, indent=1, sort_keys=False) + "\n")
    print(f"wrote {path} ({path.stat().st_size} bytes); {len(problems)} validation problem(s)")
    for line in problems[:20]:
        print("  -", line)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
