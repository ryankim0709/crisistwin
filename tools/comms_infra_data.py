"""Communications-infrastructure data for CrisisTwin (cell sites, outages, alerting, 911).

Network access happens only when a sub-command is run (``manifest``, ``download``);
importing this module and running the tests never touches the network.

Commands (run from the repo root, ``python -m tools.comms_infra_data <cmd>``):

    manifest [--out PATH]            HEAD every remote source; record URL, size, last-modified
    download --dest DIR              download the machine-readable sources; record size + SHA-256
    extract-asr ZIP                  Butte County extract from FCC ASR ``r_tower.zip``
    extract-uls ZIP                  Butte County extract from FCC ULS ``l_cell.zip``
    extract-codered PDF_OR_TXT       NIST TN 2252 sup. Tables D-2 / D-3 (needs ``pdftotext`` for a PDF)
    validate [PATH]                  validate ``tools/comms_degradation.json``

Downloaded files are untrusted data: put them in an empty directory and read them only
through this module's parsers (they are parsed as text, never executed).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIR = ROOT / "tools" / "comms_fixtures"
PARAMS_PATH = ROOT / "tools" / "comms_degradation.json"
BUTTE_FIPS = "06007"
BUTTE_BBOX = (39.2, -122.1, 40.2, -121.0)  # lat_min, lon_min, lat_max, lon_max; sanity check only
# data.fcc.gov answered 403 to a user agent containing the word "fetch" (checked 2026-10-24).
USER_AGENT = "CrisisTwin-research/0.1"
OUTCOMES = ("delivered", "machine", "intercept", "busy", "timed_out")

# Every remote source we looked at, with the licence decision. ``fetch`` marks the ones the
# ``download`` command pulls; the rest are only recorded.
SOURCES = [
    {"id": "fcc-asr-r-tower", "fetch": True,
     "url": "https://data.fcc.gov/download/pub/uls/complete/r_tower.zip",
     "licence": "US federal public data; no use restriction stated", "status": "used",
     "note": "ASR registrations (RA/CO/EN/HS/SC). Weekly dump. Only tall or airport-adjacent structures must register, so most cell sites are absent."},
    {"id": "fcc-uls-l-cell", "fetch": True,
     "url": "https://data.fcc.gov/download/pub/uls/complete/l_cell.zip",
     "licence": "US federal public data; no use restriction stated", "status": "used",
     "note": "ULS Cellular (CL) licences with site locations (LO.dat). Legacy Part 22 only; PCS/AWS/700 MHz are market licences without site coordinates."},
    {"id": "nist-tn2252-sup", "fetch": True,
     "url": "https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.2252sup.pdf",
     "licence": "NIST publication, US government work (public domain in the US)", "status": "used",
     "note": "Appendix D Tables D-1..D-3 (CodeRED). Table D-1 already transcribed in tools/camp_codedred_table.json."},
    {"id": "fcc-dirs-2019-10-26", "fetch": True,
     "url": "https://docs.fcc.gov/public/attachments/DOC-360452A1.pdf",
     "licence": "FCC public document", "status": "used",
     "note": "DIRS status report, 26 Oct 2019 (Butte: 174 cell sites served, 0 out)."},
    {"id": "fcc-dirs-2019-11-01", "fetch": True,
     "url": "https://docs.fcc.gov/public/attachments/DOC-360597A1.pdf",
     "licence": "FCC public document", "status": "cited",
     "note": "DIRS status report, 1 Nov 2019."},
    {"id": "fcc-dirs-2019-10-30", "fetch": True,
     "url": "https://www.tellusventure.com/downloads/fcc/2019/fcc_communications_status_report_california_30oct2019.pdf",
     "licence": "FCC public document, third-party mirror (original FCC URL not found)", "status": "used",
     "note": "Contains the 29 and 30 Oct 2019 DIRS reports (Butte, Marin, Sonoma by cause)."},
    {"id": "cpuc-pge-psps-2019-10-09", "fetch": True,
     "url": "https://www.cpuc.ca.gov/-/media/cpuc-website/divisions/safety-and-enforcement-division/reports/psps-post-event-reports/2019-and-earlier/pge-public-safety-power-shutoff-oct-912-report.pdf",
     "licence": "State of California public record", "status": "used",
     "note": "PG&E PSPS post-event report, 9-12 Oct 2019 (~729,000 customers)."},
    {"id": "cpuc-pge-psps-2019-10-26", "fetch": True,
     "url": "https://webproda.cpuc.ca.gov/-/media/cpuc-website/divisions/safety-and-enforcement-division/reports/psps-post-event-reports/2019/pge-psps-postevent-report-oct-2629-2019-amended.pdf",
     "licence": "State of California public record", "status": "used",
     "note": "PG&E PSPS post-event report, 26-29 Oct 2019, amended (~941,000 unique customers, mean outage ~55 h)."},
    {"id": "cdc-nhis-wireless-state-2018", "fetch": True,
     "url": "https://archive.cdc.gov/www_cdc_gov/nchs/data/nhis/earlyrelease/Wireless_state_201912-508.pdf",
     "licence": "CDC/NCHS public domain", "status": "used",
     "note": "Table 1: modeled household telephone status of adults by state, 2018. www.cdc.gov returned an HTML block page to curl; archive.cdc.gov served the PDF."},
    {"id": "house-gossner-2020", "fetch": True,
     "url": "https://www.congress.gov/116/meeting/house/110641/witnesses/HHRG-116-IF16-Wstate-GossnerA-20200227.pdf",
     "licence": "Congressional record, public", "status": "used",
     "note": "Santa Rosa Fire Chief testimony citing Cal OES counts (341 sites 2017; 489 Camp+Woolsey 2018; ~70 towers in first hours of Tubbs)."},
    {"id": "jenner-cpuc-d2007011", "fetch": True,
     "url": "https://www.jenner.com/a/web/jsC8xNXB8TEjYWBUk1aJ9n/4k1WQf/New_Backup_Power_Mandates_for_California_Communications_Companies.pdf",
     "licence": "Law-firm client alert (secondary source for CPUC D.20-07-011)", "status": "secondary",
     "note": "Primary decision text not retrieved; verify at docs.cpuc.ca.gov before relying on details."},
    {"id": "opencellid", "fetch": False,
     "url": "https://opencellid.org/downloads.php",
     "licence": "CC BY-SA 4.0 plus mandatory visible credit (docs.opencellid.org/docs/attribution)", "status": "unavailable",
     "note": "Downloads require an API access token (account), which the project rules exclude; share-alike would also bind any derived dataset we ship. Not used."},
    {"id": "hifld-cellular-towers", "fetch": False,
     "url": "https://catalog.data.gov/dataset/cellular-towers",
     "licence": "data.gov record lists US Government Works; HIFLD Open was deactivated 2025-08-26", "status": "unavailable",
     "note": "Live service gone; archived copies (DataLumos DOI 10.3886/E238960V1) re-derive FCC data we already read directly. Not used."},
]


# ---------------------------------------------------------------- hashing and download

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def head(url: str, timeout: int = 30) -> dict:
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return {"http_status": r.status, "content_length": int(r.headers.get("Content-Length") or 0) or None,
                    "last_modified": r.headers.get("Last-Modified"), "content_type": r.headers.get("Content-Type")}
    except Exception as exc:  # recorded as unavailable, never fatal
        return {"http_status": None, "error": type(exc).__name__ + ": " + str(exc)[:120]}


def download(url: str, dest: Path, timeout: int = 300) -> dict:
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r, open(dest, "wb") as fh:
            while chunk := r.read(1 << 20):
                fh.write(chunk)
    except Exception as exc:
        return {"url": url, "status": "unavailable", "error": type(exc).__name__ + ": " + str(exc)[:120]}
    return {"url": url, "status": "downloaded", "file": dest.name, "bytes": dest.stat().st_size,
            "sha256": sha256_file(dest)}


# ---------------------------------------------------------------- coordinates

def dms_to_deg(deg: str, minutes: str, seconds: str, hemi: str) -> float:
    value = float(deg) + float(minutes) / 60 + float(seconds or 0) / 3600
    return round(-value if hemi.upper() in ("S", "W") else value, 6)


def in_bbox(lat: float, lon: float, bbox=BUTTE_BBOX) -> bool:
    return bbox[0] <= lat <= bbox[2] and bbox[1] <= lon <= bbox[3]


def _num(s: str):
    try:
        return float(s)
    except ValueError:
        return None


def _read_dat(zf: zipfile.ZipFile, name: str):
    with zf.open(name) as fh:
        for raw in fh:
            yield raw.decode("latin-1").rstrip("\r\n").split("|")


# ---------------------------------------------------------------- FCC ASR

def extract_asr(zip_path: Path, county_fips: str = BUTTE_FIPS) -> list[dict]:
    """Structures registered in one California county. Contact and owner fields are dropped.

    RA.dat columns used (0-based): 3 registration number, 5 structure status code,
    8 application status code, 13 dismantle date, 23 site description, 24 city,
    25 state, 26 county FIPS, 28 structure height m, 29 ground elevation m, 32 structure type.
    CO.dat: 3 registration number, 5 coordinate type (T = tower), 6-9 latitude DMS, 11-14 longitude DMS.
    """
    with zipfile.ZipFile(zip_path) as zf:
        coords = {}
        for f in _read_dat(zf, "CO.dat"):
            if len(f) > 14 and f[5] == "T" and f[3] not in coords:
                try:
                    coords[f[3]] = (dms_to_deg(f[6], f[7], f[8], f[9]), dms_to_deg(f[11], f[12], f[13], f[14]))
                except ValueError:
                    continue
        rows = []
        for f in _read_dat(zf, "RA.dat"):
            if len(f) < 33 or f[25] != "CA" or f[26] != county_fips or f[3] not in coords:
                continue
            lat, lon = coords[f[3]]
            rows.append({
                "registration_number": f[3], "structure_status_code": f[5], "application_status_code": f[8],
                "dismantled": bool(f[13]), "site_description": f[23].strip().title(), "city": f[24].strip().title(),
                "structure_type": f[32], "height_m": _num(f[28]), "ground_elevation_m": _num(f[29]),
                "lat": lat, "lon": lon,
            })
    rows.sort(key=lambda r: int(r["registration_number"]))
    return rows


# ---------------------------------------------------------------- FCC ULS cellular

STRUCTURE_TYPES = {"TOWER", "MAST", "POLE", "BLDG", "BANT", "LTOWER", "MTOWER", "GTOWER"}


def extract_uls_cellular(zip_path: Path, county: str = "BUTTE") -> list[dict]:
    """Active legacy Cellular (CL) licence locations in one California county.

    LO.dat: 1 USI, 4 call sign, 8 location number, 11 address, 12 city, 13 county, 14 state,
    19-26 latitude/longitude DMS. HD.dat: 1 USI, 5 licence status (A = active), 6 service.
    """
    with zipfile.ZipFile(zip_path) as zf:
        status = {f[1]: f[5] for f in _read_dat(zf, "HD.dat") if len(f) > 6}
        rows = []
        for f in _read_dat(zf, "LO.dat"):
            if len(f) < 28 or f[14] != "CA" or f[13].upper() != county or status.get(f[1]) != "A":
                continue
            try:
                lat = dms_to_deg(f[19], f[20], f[21], f[22])
                lon = dms_to_deg(f[23], f[24], f[25], f[26])
            except ValueError:
                continue
            rows.append({"call_sign": f[4], "location_number": f[8], "address": f[11].strip().title(),
                         "city": f[12].strip().title(), "lat": lat, "lon": lon,
                         "structure_type": next((x for x in f[27:] if x in STRUCTURE_TYPES), "")})
    rows.sort(key=lambda r: (r["call_sign"], r["location_number"]))
    return rows


# ---------------------------------------------------------------- NIST TN 2252 sup. Appendix D

_TIME = re.compile(r"^\d{1,2}:\d{2}$")
_DASHES = ("—", "-", "–")


def _pct(tok: str):
    return None if tok in _DASHES else round(int(tok.rstrip("%")) / 100, 2)


def _int(tok: str):
    return None if tok in _DASHES else int(tok.replace(",", ""))


def _minutes(clock: str) -> int:
    h, m = clock.split(":")
    return int(h) * 60 + int(m)


def parse_codered_tables(text: str) -> dict:
    """Parse Tables D-2 (initial calls) and D-3 (re-calls) from ``pdftotext -layout`` output.

    Times are as printed: hours since 00:00 on 2018-11-08 (so 25:18 is 01:18 on Nov 9), Pacific Standard Time.
    """
    d2_at = text.rfind("Table D-2. Statistics")
    d3_at = text.rfind("Table D-3. Statistics")
    end_at = text.find("Appendix E", d3_at)
    if min(d2_at, d3_at, end_at) < 0:
        raise ValueError("Tables D-2 / D-3 not found")
    initial, recalls = [], []
    for line in text[d2_at:d3_at].splitlines():
        t = re.sub(r"^\s*D-\d+\s+", "", line).split()
        if not t or not _TIME.match(t[0]):
            continue
        if len(t) == 20:
            e, p, tx, tdd, att, rea, nrea = (_int(x) for x in t[1:8])
            pct, est, succ, conn = t[8:13], t[13:18], _pct(t[18]), _int(t[19])
            est = [_int(x) for x in est]
        elif len(t) == 6:  # the 09:09 row prints only outcome fractions (Town of Paradise message)
            e = p = tx = tdd = att = rea = nrea = succ = conn = None
            pct, est = t[1:6], [None] * 5
        else:
            raise ValueError(f"unexpected D-2 row: {line.strip()[:80]}")
        initial.append({"initial_time": t[0], "initial_minutes": _minutes(t[0]), "emails": e, "phone_calls": p,
                        "text_messages": tx, "tdd": tdd, "attempted": att, "reached": rea, "not_reached": nrea,
                        "outcome_fraction": dict(zip(OUTCOMES, (_pct(x) for x in pct))),
                        "outcome_calls_estimated": dict(zip(OUTCOMES, est)),
                        "call_success": succ, "total_connections": conn})
    for line in text[d3_at:end_at].splitlines():
        t = re.sub(r"^\s*D-\d+\s+", "", line).split()
        if not t or not _TIME.match(t[0]):
            continue
        if len(t) != 18:
            raise ValueError(f"unexpected D-3 row: {line.strip()[:80]}")
        phone, att, rea, nrea = (_int(x) for x in t[2:6])
        recalls.append({"initial_time": t[0], "recall_time": t[1], "recall_delay_min": _minutes(t[1]) - _minutes(t[0]),
                        "phone_calls": phone, "attempted": att, "reached": rea, "not_reached": nrea,
                        "outcome_fraction": dict(zip(OUTCOMES, (_pct(x) for x in t[6:11]))),
                        "call_success": _pct(t[16]), "total_connections": _int(t[17])})
    return {"initial": initial, "recalls": recalls}


def codered_summary(tables: dict) -> dict:
    """Phone-weighted success rates, for checking against the NIST narrative (55 % initial, 7 % re-call)."""
    def weighted(rows):
        rows = [r for r in rows if r["phone_calls"] and r["reached"] is not None]
        calls = sum(r["phone_calls"] for r in rows)
        return round(sum(r["reached"] for r in rows) / calls, 3), calls, len(rows)
    ini, rec = weighted(tables["initial"]), weighted(tables["recalls"])
    succ = [r["call_success"] for r in tables["initial"] if r["call_success"] is not None]
    rsucc = [r["call_success"] for r in tables["recalls"] if r["call_success"] is not None]
    return {"initial_success_weighted": ini[0], "initial_phone_calls": ini[1], "initial_rows": ini[2],
            "initial_success_unweighted_mean": round(sum(succ) / len(succ), 3),
            "recall_success_weighted": rec[0], "recall_phone_calls": rec[1], "recall_rows": rec[2],
            "recall_success_unweighted_mean": round(sum(rsucc) / len(rsucc), 3)}


def pdf_to_text(pdf: Path) -> str:
    return subprocess.run(["pdftotext", "-layout", str(pdf), "-"], check=True, capture_output=True, text=True).stdout


# ---------------------------------------------------------------- parameter file validation

PROVENANCE = {"sourced", "derived", "ASSUMPTION"}
SOURCE_KINDS = {"primary", "secondary", "news", "fixture"}


def validate_degradation(doc: dict) -> list[str]:
    """Return a list of problems; empty means valid.

    Rules (AGENTS.md: sourced or ASSUMPTION): every leaf parameter has ``provenance`` of
    sourced / derived / ASSUMPTION; sourced and derived carry ``source_ids`` that exist in
    ``sources``; ASSUMPTION carries a ``rationale``; every leaf has a ``unit``; numbers are finite,
    non-negative, and shares are at most 1.
    """
    errors: list[str] = []
    sources = doc.get("sources")
    if not isinstance(sources, dict) or not sources:
        return ["missing sources"]
    for sid, s in sources.items():
        if not s.get("citation"):
            errors.append(f"source {sid}: missing citation")
        if s.get("kind") not in SOURCE_KINDS:
            errors.append(f"source {sid}: kind must be one of {sorted(SOURCE_KINDS)}")

    def walk(node, path):
        if isinstance(node, dict) and "provenance" in node:
            where = ".".join(path)
            prov = node["provenance"]
            if prov not in PROVENANCE:
                errors.append(f"{where}: bad provenance {prov!r}")
            elif prov == "ASSUMPTION":
                if not node.get("rationale"):
                    errors.append(f"{where}: ASSUMPTION needs rationale")
            else:
                ids = node.get("source_ids") or []
                if not ids:
                    errors.append(f"{where}: {prov} needs source_ids")
                for i in ids:
                    if i not in sources:
                        errors.append(f"{where}: unknown source id {i}")
            if "unit" not in node:
                errors.append(f"{where}: missing unit")
            for key in ("value", "low", "high"):
                v = node.get(key)
                if v is None:
                    continue
                if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or abs(v) == float("inf"):
                    errors.append(f"{where}.{key}: not a finite number")
                elif v < 0:
                    errors.append(f"{where}.{key}: negative")
                elif node.get("unit") == "share" and v > 1:
                    errors.append(f"{where}.{key}: share above 1")
            if node.get("low") is not None and node.get("high") is not None and node["low"] > node["high"]:
                errors.append(f"{where}: low > high")
            if node.get("value") is None and node.get("low") is None:
                errors.append(f"{where}: needs value or low/high")
        elif isinstance(node, dict):
            for k, v in node.items():
                if k not in ("sources", "meta"):
                    walk(v, path + [k])

    walk(doc, [])
    return errors


# ---------------------------------------------------------------- CLI

def _dump(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    manifest_p = sub.add_parser("manifest")
    manifest_p.add_argument("--out", type=Path, default=FIXTURE_DIR / "source_manifest.json")
    dl_p = sub.add_parser("download")
    dl_p.add_argument("--dest", type=Path, required=True)
    dl_p.add_argument("--out", type=Path, default=FIXTURE_DIR / "source_manifest.json")
    asr_p = sub.add_parser("extract-asr")
    asr_p.add_argument("zip", type=Path)
    asr_p.add_argument("--out", type=Path, default=FIXTURE_DIR / "butte_asr_structures.json")
    uls_p = sub.add_parser("extract-uls")
    uls_p.add_argument("zip", type=Path)
    uls_p.add_argument("--out", type=Path, default=FIXTURE_DIR / "butte_uls_cellular_sites.json")
    cr_p = sub.add_parser("extract-codered")
    cr_p.add_argument("src", type=Path)
    cr_p.add_argument("--out", type=Path, default=FIXTURE_DIR / "codered_delivery_table.json")
    val_p = sub.add_parser("validate")
    val_p.add_argument("path", type=Path, nargs="?", default=PARAMS_PATH)
    a = ap.parse_args(argv)

    if a.cmd == "manifest":
        out = [{**{k: s[k] for k in ("id", "url", "licence", "status")}, **head(s["url"])} for s in SOURCES]
        _dump(a.out, {"checked_by": "tools.comms_infra_data manifest", "sources": out})
    elif a.cmd == "download":
        out = []
        for s in SOURCES:
            rec = {"id": s["id"], "licence": s["licence"], "decision": s["status"]}
            if s["fetch"]:
                rec.update(download(s["url"], a.dest / (s["id"] + Path(s["url"]).suffix)))
            else:
                rec.update({"url": s["url"], "status": "unavailable", "reason": s["note"]})
            out.append(rec)
        _dump(a.out, {"sources": out})
    elif a.cmd == "extract-asr":
        rows = extract_asr(a.zip)
        _dump(a.out, {"source_id": "fcc-asr-r-tower", "source_sha256": sha256_file(a.zip), "county_fips": BUTTE_FIPS,
                      "label": "FIXTURE: registered antenna structures (all uses), not a cell-site census",
                      "count": len(rows), "rows": rows})
    elif a.cmd == "extract-uls":
        rows = extract_uls_cellular(a.zip)
        _dump(a.out, {"source_id": "fcc-uls-l-cell", "source_sha256": sha256_file(a.zip), "county": "BUTTE",
                      "label": "FIXTURE: legacy cellular licence locations, not a cell-site census",
                      "count": len(rows), "rows": rows})
    elif a.cmd == "extract-codered":
        text = pdf_to_text(a.src) if a.src.suffix == ".pdf" else a.src.read_text(encoding="utf-8")
        tables = parse_codered_tables(text)
        _dump(a.out, {"source_id": "nist-tn2252-sup", "tables": "D-2, D-3", "time_zone": "America/Los_Angeles (PST, UTC-8)",
                      "incident_local_date": "2018-11-08",
                      "label": "OBSERVED (script-transcribed): BCSO CodeRED output; a connection is not proof of receipt",
                      "summary": codered_summary(tables), **tables})
    elif a.cmd == "validate":
        errs = validate_degradation(json.loads(a.path.read_text(encoding="utf-8")))
        print("\n".join(errs) or "ok")
        return 1 if errs else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
