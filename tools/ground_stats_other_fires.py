"""Aggregate emergency-communications statistics for the Marshall, Woolsey and Kincade fires.

Calibration input for a future ground-data generator, next to the Camp Fire record in
`camp_ground_record.py`. The figures are hand-reviewed: each row of `SPEC` below names a number
printed in a public after-action report and a short verbatim anchor (at most 25 words) that
contains or sits beside it. This script

1. downloads each source with curl into --cache-dir (outside the repository) and records its
   size and SHA-256 (a changed digest fails the run),
2. extracts text per page with `pdftotext -raw` (poppler), page = 1-based PDF page,
3. checks that every anchor occurs on its cited page (whitespace collapsed),
4. writes `ground_stats_other_fires.json` with a 12-hex SHA-256 of each anchor instead of the
   quote itself.

Aggregates only; the sources contain no individual call content and none is stored.
A source that cannot be downloaded is recorded as unavailable and its rows are not written
(`--allow-unavailable`); nothing is worked around.

    python3.12 -m tools.ground_stats_other_fires --cache-dir ~/crisistwin-sources/ground
    python3.12 -m tools.ground_stats_other_fires --cache-dir DIR --check   # verify, no write
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

OUTPUT_PATH = Path(__file__).with_name("ground_stats_other_fires.json")
PDFTOTEXT = "/opt/homebrew/bin/pdftotext"
NORMALIZER_VERSION = "ground-stats-other-fires-1"

SOURCES = {
    "boco-aar-marshall-2022": {
        "file": "marshall-aar.pdf",
        "url": "https://assets.bouldercounty.gov/wp-content/uploads/2025/03/marshall-fire-operational-after-action-report-003.pdf",
        "title": "Marshall Fire Operational After Action Report (Boulder County, 30 Dec 2022)",
        "sha256": "9180089493c024a2b96aada80121311221e10f0b55cb816bd2b35b727282789c",
    },
    "boco-everbridge-2022": {
        "file": "marshall-everbridge.pdf",
        "url": "https://web.archive.org/web/20220106235818id_/https://assets.bouldercounty.org/wp-content/uploads/2022/01/Everbridge-Information-FINAL.pdf",
        "title": "Information on Boulder County's Emergency Notification System (Jan 2022, Wayback copy)",
        "sha256": "797a38565bdff5a55d5aa1918656292c9354ea6ebae4953adde5cc96189a2764",
    },
    "citygate-aar-2019": {
        "file": "woolsey-citygate-aar.pdf",
        "url": "https://file.lacounty.gov/SDSInter/bos/supdocs/144968.pdf",
        "title": "After Action Review of the Woolsey Fire Incident (Citygate Associates for Los Angeles County)",
        "sha256": "61d478bcd50df4a259f550345568001ed7c9c30f79655c17eb93f7b3c3d8a554",
    },
    "sonoma-kincade-aar-2020": {
        "file": "kincade-aar.pdf",
        "url": "https://sonomacounty.gov/Main%20County%20Site/Administrative%20Support%20&%20Fiscal%20Services/Emergency%20Management/Documents/Archive/Administration/Services/Training__3/Service%201/_Documents/Sonoma-County-2019-Kincade-Fire-AAR-FINAL-ADA.pdf",
        "title": "2019 Kincade Fire After-Action Report and Improvement Plan (County of Sonoma, Mar 2020)",
        "sha256": "00d8e7e31a4f77aaac018ac5e3d821165986b29b14fe92c78ee7691a50088801",
    },
}

# Source clocks. Marshall: MST (UTC-7) on 2021-12-30. Woolsey: PST (UTC-8) on 2018-11-09.
TZ = {
    "marshall": "America/Denver (MST, UTC-07:00 on 2021-12-30)",
    "woolsey": "America/Los_Angeles (PST, UTC-08:00 from 2018-11-04)",
    "kincade": "America/Los_Angeles (PDT, UTC-07:00 until 2019-11-03)",
}

W_DAY = ("2018-11-09T08:00:00Z", "2018-11-10T08:00:00Z")  # Fri 9 Nov 2018, 00:00-24:00 PST

# (fire, metric, value, unit, period_start, period_end, source_id, pdf page, anchor, note)
SPEC = [
    # --- Marshall (Boulder County) ---
    ("marshall", "calls_to_911_center_before_marshall_ignition_lower_bound", 200, "calls", None, None,
     "boco-aar-marshall-2022", 4, "The 911 center was receiving hundreds of calls",
     "Source says 'hundreds' while the Middle Fork Fire (10:15 local) was active; 200 is a lower bound, no window stated."),
    ("marshall", "psap_overload_event", 1, "events", "2021-12-30T19:41:00Z", "2021-12-30T19:41:00Z",
     "boco-aar-marshall-2022", 6, "1241: 911 Center started airing home addresses and was overwhelmed with reports.",
     "Timeline entry 12:41 MST; one event, no call count given."),
    ("marshall", "dispatchers_dedicated_to_evacuations_and_everbridge", 1, "dispatchers", None, None,
     "boco-aar-marshall-2022", 9, "then identified a single dispatcher to manage evacuations and Everbridge",
     "Additional dispatch staff were called in; no headcount is printed."),
    ("marshall", "residents_evacuated", 37500, "persons", None, None,
     "boco-aar-marshall-2022", 9, "The evacuation of 37,500 people during a fast moving",
     "Source window 3-4 hours. Denominator."),
    ("marshall", "everbridge_order_contacts", 215, "contacts", "2021-12-30T18:47:52Z", "2021-12-30T18:47:52Z",
     "boco-everbridge-2022", 3, "215 Marshall Fire1", "Launch 11:47:52 MST. Contacts = delivery paths attempted."),
    ("marshall", "everbridge_order_contacts", 2588, "contacts", "2021-12-30T19:15:55Z", "2021-12-30T19:15:55Z",
     "boco-everbridge-2022", 3, "2588 Marshall Fire2a, 2b", "Launch 12:15:55 MST."),
    ("marshall", "everbridge_order_contacts", 254, "contacts", "2021-12-30T19:46:18Z", "2021-12-30T19:46:18Z",
     "boco-everbridge-2022", 3, "254 Marshall Fire3a, 3b", "Launch 12:46:18 MST."),
    ("marshall", "everbridge_warning_contacts", 4173, "contacts", "2021-12-30T19:49:56Z", "2021-12-30T19:49:56Z",
     "boco-everbridge-2022", 3, "4173 Marshall Fire4", "Evacuation Warning, launch 12:49:56 MST."),
    ("marshall", "everbridge_order_contacts", 7251, "contacts", "2021-12-30T20:08:48Z", "2021-12-30T20:08:48Z",
     "boco-everbridge-2022", 3, "7251 Marshall Fire5a, 5b", "Launch 13:08:48 MST."),
    ("marshall", "everbridge_order_contacts", 2509, "contacts", "2021-12-30T20:15:08Z", "2021-12-30T20:15:08Z",
     "boco-everbridge-2022", 3, "2509 Marshall Fire6a, 6b", "Launch 13:15:08 MST."),
    ("marshall", "everbridge_order_contacts", 276, "contacts", "2021-12-30T20:25:39Z", "2021-12-30T20:25:39Z",
     "boco-everbridge-2022", 3, "276 Marshall Fire7", "Launch 13:25:39 MST."),
    ("marshall", "everbridge_order_contacts", 4806, "contacts", "2021-12-30T21:51:14Z", "2021-12-30T21:51:14Z",
     "boco-everbridge-2022", 3, "4806 Marshall Fire8", "Launch 14:51:14 MST."),
    ("marshall", "everbridge_warning_contacts", 2217, "contacts", "2021-12-30T21:58:04Z", "2021-12-30T21:58:04Z",
     "boco-everbridge-2022", 3, "2217 Marshall Fire9", "Evacuation Warning, launch 14:58:04 MST."),
    ("marshall", "wea_alerts_sent", 0, "alerts", None, None,
     "boco-everbridge-2022", 4, "is currently working to implement Wireless Emergency Alerts (WEA)",
     "WEA was still being implemented in Boulder County (planned 2022); none is described for the fire."),
    # --- Woolsey (Los Angeles / Ventura) ---
    ("woolsey", "la_county_fire_normal_911_calls_per_day", 1100, "calls_per_day", None, None,
     "citygate-aar-2019", 13, "nearly 1,100 daily 9-1-1 calls throughout the",
     "Normal LA County Fire jurisdiction volume ('nearly')."),
    ("woolsey", "la_county_fire_additional_calls_for_help", 1800, "calls", W_DAY[0], W_DAY[1],
     "citygate-aar-2019", 33, "received approximately 1,800 additional calls for help",
     "'Approximately', above the normal ~1,100 countywide volume, from neighbourhoods in the fire area; Fri 9 Nov, day boundaries assumed 00:00-24:00 PST."),
    ("woolsey", "share_of_911_calls_not_life_threatening_informal", 0.5, "fraction", W_DAY[0], W_DAY[1],
     "citygate-aar-2019", 34, "almost half the 9-1-1 calls were not life threatening",
     "Informal estimate ('almost half') for some threatened areas."),
    ("woolsey", "la_county_fire_emergency_responses_dispatched_2017", 394000, "responses_per_year",
     "2017-01-01T08:00:00Z", "2018-01-01T08:00:00Z",
     "citygate-aar-2019", 143, "in 2017 Command and Control dispatched over 394,000 emergency responses",
     "Lower bound ('over'); baseline year, not the fire."),
    ("woolsey", "la_county_fire_dispatchers_daily_staffing", 17, "dispatchers", None, None,
     "citygate-aar-2019", 143, "Daily staffing includes 17 Dispatchers, three Dispatch Supervisors",
     "Normal daily staffing; one fire captain and one battalion chief also listed."),
    ("woolsey", "la_county_fire_dispatch_supervisors_daily_staffing", 3, "supervisors", None, None,
     "citygate-aar-2019", 143, "Daily staffing includes 17 Dispatchers, three Dispatch Supervisors",
     "Normal daily staffing."),
    ("woolsey", "la_county_fire_engines_fielded_to_woolsey", 100, "engines", None, None,
     "citygate-aar-2019", 42, "LA County Fire fielded 100 engines/units to the Woolsey Fire",
     "First two days of the incident; context for 911 response capacity."),
    ("woolsey", "wea_and_eas_alerts_sent", 0, "alerts", None, None,
     "citygate-aar-2019", 97, "Because they were perceived to be indirect tools that cover too wide of an area, the EAS",
     "Finding 97: LA County did not use EAS or WEA; Alert LA message counts are not printed."),
    ("woolsey", "residents_evacuated", 250000, "persons", None, None,
     "citygate-aar-2019", 13, "evacuated over a quarter of a million people and their animals from harm",
     "Lower bound ('over'), both counties, whole incident. Denominator."),
    # --- Kincade (Sonoma) ---
    ("kincade", "residents_evacuated_peak", 186000, "persons", None, None,
     "sonoma-kincade-aar-2020", 3, "Over 186,000 people were evacuated from their homes",
     "Rounded ('over'); denominator. The AAR prints no 911, CAD, radio or alert counts."),
    ("kincade", "county_211_overflow_for_non_emergency_911_calls", 1, "services", None, None,
     "sonoma-kincade-aar-2020", 16, "provided an overflow for non-emergency calls going to 911",
     "Qualitative: a 211 contract took non-emergency calls off 911; no call count printed."),
]


class SourceError(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fetch(source_id: str, cache_dir: Path) -> Path:
    src = SOURCES[source_id]
    path = cache_dir / src["file"]
    if not path.exists():
        cache_dir.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".part")
        r = subprocess.run(["curl", "-sSL", "--fail", "--max-time", "180", "-o", str(tmp), src["url"]],
                           capture_output=True, text=True)
        if r.returncode != 0:
            tmp.unlink(missing_ok=True)
            raise SourceError(f"{source_id}: download failed ({r.stderr.strip() or r.returncode})")
        tmp.rename(path)
    if sha256_file(path) != src["sha256"]:
        raise SourceError(f"{source_id}: SHA-256 differs from the pinned digest {src['sha256']}")
    return path


def page_texts(pdf: Path) -> list[str]:
    out = subprocess.run([PDFTOTEXT, "-raw", str(pdf), "-"], capture_output=True, text=True, check=True).stdout
    return [" ".join(p.split()) for p in out.split("\f")]


def quote_hash(quote: str) -> str:
    return hashlib.sha256(" ".join(quote.split()).encode("utf-8")).hexdigest()[:12]


def build(cache_dir: Path, allow_unavailable: bool) -> dict:
    texts: dict[str, list[str]] = {}
    sources, unavailable = [], []
    for sid, src in SOURCES.items():
        try:
            path = fetch(sid, cache_dir)
        except SourceError as exc:
            if not allow_unavailable:
                raise
            unavailable.append({"source_id": sid, "url": src["url"], "reason": str(exc)})
            continue
        texts[sid] = page_texts(path)
        sources.append({"source_id": sid, "title": src["title"], "url": src["url"],
                        "bytes": path.stat().st_size, "sha256": sha256_file(path), "pages": len(texts[sid]) - 1})
    items = []
    for fire, metric, value, unit, start, end, sid, page, quote, note in SPEC:
        if sid not in texts:
            continue
        pages = texts[sid]
        if page > len(pages) or " ".join(quote.split()) not in pages[page - 1]:
            raise SourceError(f"{sid} p.{page}: anchor not found: {quote!r}")
        items.append({"fire": fire, "metric": metric, "value": value, "unit": unit,
                      "period_start": start, "period_end": end, "time_zone_source": TZ[fire],
                      "source_id": sid, "source_url": SOURCES[sid]["url"], "page": page,
                      "quote_sha12": quote_hash(quote), "evidence_class": "reported", "note": note})
    return {
        "dataset": "Marshall 2021, Woolsey 2018 and Kincade 2019 emergency-communications volume statistics (aggregates)",
        "source_url": [s["url"] for s in sources],
        "source_sha256": {s["source_id"]: s["sha256"] for s in sources},
        "sources": sources,
        "unavailable_sources": unavailable,
        "licence": "County after-action reports and notices; only numbers and short-quote hashes are kept.",
        "generator": f"tools/ground_stats_other_fires.py ({NORMALIZER_VERSION})",
        "time_zone": "UTC",
        "source_time_zone": TZ,
        "page_basis": "1-based PDF page of the downloaded file (printed page numbers differ)",
        "interpretation": ("Figures as printed in the sources; 'approximately', 'over' and 'hundreds' are kept in "
                           "note. Not CAD exports and not comparable across fires without the limits in "
                           "docs/historical-data.md. No individual call content. Periods are null when the source "
                           "gives none. Everbridge 'contacts' are delivery paths attempted, not people reached."),
        "quote_policy": "quote_sha12 = first 12 hex of SHA-256 over the whitespace-collapsed anchor (UTF-8)",
        "extraction": "hand-reviewed SPEC; anchors verified on the cited page with pdftotext -raw",
        "items": items,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--cache-dir", type=Path, required=True)
    ap.add_argument("--check", action="store_true", help="verify the committed JSON, do not write")
    ap.add_argument("--allow-unavailable", action="store_true", help="record undownloadable sources and continue")
    args = ap.parse_args(argv)
    doc = build(args.cache_dir.expanduser(), args.allow_unavailable)
    if args.check:
        if json.loads(OUTPUT_PATH.read_text()) != doc:
            print("committed JSON differs from a fresh build", file=sys.stderr)
            return 1
        print(f"ok: {len(doc['items'])} items")
        return 0
    OUTPUT_PATH.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {OUTPUT_PATH} ({len(doc['items'])} items)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
