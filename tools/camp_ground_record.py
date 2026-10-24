"""Build the de-identified Camp Fire (2018-11-08) ground record from the NIST TN 2252 reports.

The ground record is a time-stamped list of 911 calls, radio-log entries, rescue
requests and NIST timeline rows for the /live drill console. It is cut from:

- NIST TN 2252sup Table A-2 (NETTRA data), rows whose Info. Source is a 911 call
  ("911-NNN-n") or the "Radio Log";
- NIST TN 2252sup Table K-1 (evacuation assistance / rescue events);
- NIST TN 2252 main report Table 10 (notification timeline) and Table 13 (Paradise
  evacuation timeline).

De-identification: no source free text is written. Each item carries a summary built
only from a template (channel, category, road name), a category from the keyword rules
in CATEGORY_RULES, a road name matched against road-name suffixes, a point rounded to
3 decimals (~100 m), and a 12-hex SHA-256 prefix of the original row text that is
used only to merge duplicate quotes of one observation.

The PDFs are downloaded with curl into --cache-dir (outside the repository); their
size and SHA-256 are written to the output header. Text is extracted with
`pdftotext -layout` (poppler). Only the Python standard library is used.

    python3.12 -m tools.camp_ground_record --cache-dir ~/crisistwin-sources/nist
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

from tools.build_camp_evacuation import SourceError


NORMALIZER_VERSION = "ground-record-1"
OUTPUT_PATH = Path(__file__).with_name("camp_ground_record.json")
SUP_URL = "https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.2252sup.pdf"
MAIN_URL = "https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.2252.pdf"
# Pinned so a re-issued PDF fails loudly instead of silently shifting rows and pages.
SOURCES = {
    "sup": {"url": SUP_URL, "local_name": "NIST.TN.2252sup.pdf",
            "sha256": "1846b31b924f510628b550b292c160c1f87e729dcdc4242d1cad1aee88d7d401"},
    "main": {"url": MAIN_URL, "local_name": "NIST.TN.2252.pdf",
             "sha256": "7d5385adfc6c86f74f43f81fd193e476ac2b3e333e17bd7f468fb98a40f200b4"},
}
# Source times are Pacific Standard Time (DST ended 2018-11-04), so UTC = local + 8 h.
SOURCE_UTC_OFFSET = timedelta(hours=-8)
COORD_DECIMALS = 3
# Rows that name a residential street (a road-suffix match not in MAIN_ROADS) get ~1 km points.
RESIDENTIAL_COORD_DECIMALS = 2

CHANNEL_LABELS = {
    "911": "911 call",
    "radio": "Radio",
    "rescue": "Rescue log",
    "notification": "Notification timeline",
    "evacuation": "Evacuation timeline",
}
CATEGORY_LABELS = {
    "fire_seen": "fire or smoke seen",
    "help_needed": "help needed",
    "trapped": "trapped by fire",
    "road_blocked": "road blocked",
    "heavy_traffic": "heavy traffic",
    "evacuation_order": "evacuation order or warning",
    "evacuation_progress": "evacuation under way",
    "shelter": "sheltering or refuge",
    "other": "other report",
}
# Ordered: the first category with a matching pattern wins. Patterns run on lower-cased text.
CATEGORY_RULES: dict[str, tuple[str, ...]] = {
    "trapped": (
        r"\btrapped\b", r"\bentrap", r"can(?:not|'t|’t) (?:get out|escape|leave)",
        r"unable to (?:get out|escape|leave)", r"not be able to get out", r"trying to escape",
        r"\bstuck\b",
    ),
    "help_needed": (
        r"\bmedical\b", r"\bneeds? (?:help|assistance|a ride|transport)",
        r"\brescue", r"\binjur", r"\bnon-?ambulatory", r"\bbedridden\b", r"\bwheelchair",
        r"\boxygen\b", r"\bno (?:transportation|vehicle|car|ride)\b", r"\bcan(?:not|'t|’t) drive\b",
        r"\bdisabled\b", r"\belderly\b", r"\bwelfare check", r"\bassistance\b", r"\bheart attack\b",
        r"\bnot breathing\b", r"\bambulance\b", r"\bmedics?\b", r"\bburn (?:patient|victim)s?\b", r"\bburns\b", r"\bno way to (?:evacuate|get out|leave)\b",
        r"(?:doesn['’]t|does not|don['’]t) have (?:a )?(?:vehicle|car|ride|transportation)",
    ),
    "road_blocked": (
        r"\bblock", r"\bclosure\b", r"\bclosed\b", r"\bshut(?:ting)? down\b", r"\bpower ?lines? (?:are )?down",
        r"\b(?:power|utility)?\s?lines down\b", r"\bdowned (?:power ?line|tree|lines)", r"\btrees? down\b",
        r"\bimpassable\b", r"\bburnover\b", r"\bfire (?:is )?(?:across|on both sides of) the road",
    ),
    "heavy_traffic": (
        r"\btraffic\b", r"\bgridlock", r"\bcongest", r"\bbacked up\b", r"\bbumper", r"\bjam(?:med)?\b",
        r"\bcontraflow\b", r"\bnot moving\b", r"\b(?:is|like) (?:pretty much )?a parking lot\b",
    ),
    "shelter": (
        r"\btras?\b", r"\bshelter", r"\brefuge\b", r"\bsafety zone\b", r"\bsafe area\b", r"\bin the black\b",
        r"\bwaiting it out\b", r"\bstay put\b",
    ),
    "evacuation_order": (
        r"\bmandatory\b", r"\bevacuation (?:order|warning)s?\b", r"\bevac(?:uation)?s? (?:order|warning)",
        r"\bissued evacuations\b", r"\bgo ahead and evacuate\b", r"\badvised? (?:them |you )?to evacuate\b",
        r"\brecommends? (?:to )?evacuat", r"\bplease evacuate\b", r"\bevacuate (?:now|immediately)\b",
        r"\bcodered\b", r"\breverse 911\b", r"\bwarning\b",
    ),
    "fire_seen": (
        r"\bfire\b", r"\bsmoke\b", r"\bflames?\b", r"\bash(?:es)?\b", r"\bembers?\b", r"\bburning\b",
        r"\bglow\b", r"\bspot fires?\b",
    ),
    "evacuation_progress": (
        r"\bevacuat(?:ed|ing|ions?)\b", r"\bevacs?\b", r"\bdoor[- ]to[- ]door\b", r"\bevacuate\b",
    ),
}
# Agency and equipment names that contain rule words ("CAL FIRE", "fire engine") are blanked first.
NEUTRAL_PHRASES = re.compile(
    r"\bcal ?fire\b|\b(?:butte )?county fire\b|\bfire (?:engines?|station|department|dept|chief|transfer|crews?|"
    r"personnel|captain|units?|resources?|side|behavior|safety zone)\b|\bstrike teams?\b"
)
_COMPILED_RULES = [(category, [re.compile(p) for p in patterns]) for category, patterns in CATEGORY_RULES.items()]

ROAD_SUFFIXES = {
    "Rd": "Road", "Road": "Road", "Ln": "Lane", "Lane": "Lane", "Dr": "Drive", "Drive": "Drive",
    "St": "Street", "Street": "Street", "Ave": "Avenue", "Avenue": "Avenue", "Way": "Way",
    "Ct": "Court", "Court": "Court", "Blvd": "Boulevard", "Pkwy": "Parkway", "Cir": "Circle",
    "Trl": "Trail", "Trail": "Trail", "Loop": "Loop", "Hwy": "Highway",
}
# Words that may precede a suffix but are not part of a road name.
ROAD_STOPWORDS = {
    "On", "At", "Of", "The", "To", "And", "From", "Via", "Near", "Down", "Up", "Across", "In", "Into",
    "Off", "Onto", "Toward", "Towards", "By", "For", "Between", "NB", "SB", "EB", "WB", "Disp", "Caller",
    "IC", "LE", "PPD", "BCSO", "CHP", "Oro", "Main", "Old", "New", "Blocking", "Block", "Open", "Shut",
    "Visible", "Info", "Information", "Repeat", "Update", "Advise", "Advising", "Request", "Requesting", "Cross",
}
# The only road names an item may carry. Main roads, arterials and collectors used for the
# Paradise, Magalia and Concow evacuation, plus the state highways. Collectors were added only
# when they appear in 3+ distinct source rows (Buschmann, Merrill, Steiffer). Hoffman Road (3 rows,
# one address-specific incident) and every court, circle, way or lane except the Edgewood Lane
# collector stay out. "Upper/Lower Skyway" and the Stirling City stretch normalize to "Skyway".
# Any other road becomes null, and its row's point is coarsened (RESIDENTIAL_COORD_DECIMALS).
MAIN_ROADS = frozenset({
    "Skyway", "Pentz Road", "Clark Road", "Neal Road", "Pearson Road", "Bille Road", "Wagstaff Road",
    "Elliott Road", "Oliver Road", "Honey Run Road", "Concow Road", "Feather River Boulevard",
    "Camp Creek Road", "Pulga Road", "Edgewood Lane", "Buschmann Road", "Merrill Road", "Steiffer Road",
    "Highway 70", "Highway 99", "Highway 191", "Highway 32",
})
_ROAD_WORD = r"[A-Z][a-z]+\.?"
_ROAD_RE = re.compile(
    r"\b((?:%s\s+){1,3})\[?(%s)\]?(?![A-Za-z])" % (_ROAD_WORD, "|".join(sorted(ROAD_SUFFIXES, key=len, reverse=True)))
)
_HIGHWAY_RE = re.compile(r"\b(?:Hwy|Highway|CA|SR|State Route)[ -]?(70|99|32|191)\b")
_SKYWAY_RE = re.compile(r"\b(?:Upper |Lower )?Skyway\b")


def utc_at(day: int, hhmm: str) -> str:
    """Convert an 11/<day> PST clock time (hours may run past 24) to an ISO UTC timestamp."""
    hours, minutes = (int(part) for part in hhmm.split(":"))
    if not (0 <= hours < 48 and 0 <= minutes < 60):
        raise SourceError(f"invalid clock time {hhmm}")
    local = datetime(2018, 11, day, tzinfo=timezone(SOURCE_UTC_OFFSET)) + timedelta(hours=hours, minutes=minutes)
    return local.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def text_sha12(text: str) -> str:
    return hashlib.sha256(normalize_text(text).encode()).hexdigest()[:12]


def normalize_text(text: str) -> str:
    return " ".join(text.replace("×", " ").split())


def categorize(text: str) -> str:
    lowered = NEUTRAL_PHRASES.sub(" ", text.lower())
    for category, patterns in _COMPILED_RULES:
        if any(pattern.search(lowered) for pattern in patterns):
            return category
    return "other"


def roads_in(text: str) -> list[str]:
    """Every road named in the text, in order, with its suffix spelled out."""
    found: list[tuple[int, str]] = []
    for match in _ROAD_RE.finditer(text):
        words = match.group(1).split()
        while words and words[0].rstrip(".") in ROAD_STOPWORDS:
            words.pop(0)
        if not words or any(word.rstrip(".") in ROAD_STOPWORDS for word in words):
            continue
        suffix = ROAD_SUFFIXES[match.group(2)]
        if suffix == "Highway":
            continue
        found.append((match.start(), " ".join(word.rstrip(".") for word in words) + " " + suffix))
    for match in _HIGHWAY_RE.finditer(text):
        found.append((match.start(), f"Highway {match.group(1)}"))
    for match in _SKYWAY_RE.finditer(text):
        found.append((match.start(), "Skyway"))
    return [name for _, name in sorted(found)]


def extract_road(text: str) -> tuple[str | None, bool]:
    """Return (first main road named, whether any non-main (residential) road is named)."""
    roads = roads_in(text)
    main = [road for road in roads if road in MAIN_ROADS]
    return (main[0] if main else None), any(road not in MAIN_ROADS for road in roads)


def summary_for(channel: str, category: str, road_name: str | None) -> str:
    text = f"{CHANNEL_LABELS[channel]}: {CATEGORY_LABELS[category]}"
    return f"{text}, {road_name}" if road_name else text


def rounded_coord(lat: str | float | None, lon: str | float | None,
                  decimals: int = COORD_DECIMALS) -> list[float] | None:
    if lat is None or lon is None:
        return None
    lat_f, lon_f = float(lat), float(lon)
    if lat_f == 0 and lon_f == 0:
        return None
    if not (39.0 < lat_f < 41.0 and -123.0 < lon_f < -120.0):
        raise SourceError(f"point outside the Camp Fire region: {lat}, {lon}")
    return [round(lon_f, decimals), round(lat_f, decimals)]


def make_item(item_id: str, at: str, precision: str, channel: str, category: str, road: str | None,
              coord: list[float] | None, evidence: str, locator: str, sha12: str) -> dict:
    return {
        "id": item_id, "at": at, "time_precision": precision, "channel": channel, "category": category,
        "road_name": road, "coord": coord, "summary": summary_for(channel, category, road),
        "evidence_class": evidence, "source_locator": locator, "text_sha12": sha12,
    }


# --- Source acquisition -------------------------------------------------------------------

def fetch(cache_dir: Path, key: str) -> tuple[Path, dict]:
    spec = SOURCES[key]
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / spec["local_name"]
    if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != spec["sha256"]:
        partial = path.with_suffix(".part")
        result = subprocess.run(
            ["curl", "--fail", "--silent", "--show-error", "--location", "--retry", "2",
             "--max-time", "600", "--output", str(partial), spec["url"]],
            capture_output=True, check=False, timeout=700,
        )
        if result.returncode:
            raise SourceError(f"download failed for {spec['url']} ({result.returncode}): "
                              f"{result.stderr.decode(errors='replace').strip()}")
        partial.replace(path)
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != spec["sha256"]:
        raise SourceError(f"{spec['url']} SHA-256 {digest} differs from the pinned {spec['sha256']}; "
                          "re-review the parser before updating the pin")
    return path, {"url": spec["url"], "bytes": len(data), "sha256": digest}


def pdf_pages(path: Path) -> list[str]:
    result = subprocess.run(["pdftotext", "-layout", str(path), "-"], capture_output=True, check=False, timeout=300)
    if result.returncode:
        raise SourceError(f"pdftotext failed on {path}: {result.stderr.decode(errors='replace').strip()}")
    return result.stdout.decode("utf-8").split("\f")


# --- Table A-2 ----------------------------------------------------------------------------

A2_ROW = re.compile(r"^\s*(?:A-\d+\s+)?11/(8|9)\s+(\d{2}:\d{2})\s+(\d+)\s+(Radio Log|\S+)")
A2_POINT = re.compile(r"\b(\d{2}\.\d{4,})\s+(-\d{3}\.\d{4,})\b")
A2_TAIL = re.compile(r"\s(Radio Log|\S+)\s+(Radio Log,?|\S+)\s*$")
# A location-source cell that spills into the observation column.
A2_SPILL = re.compile(r"^(?:Radio Log|Inferred|AVL)\s+(?:(?:V?TD|PPD)-\d+\s+|911-\d+-\d+\s+)?|^(?:(?:V?TD|PPD)-\d+|911-\d+-\d+)\s+")
A2_PAGE_MARKS = re.compile(r"^\s*A-\d+\s|NIST TN 2252(?: sup)?|July 2023")
A2_SKIP = re.compile(r"Rd Block|Obs\.$|Traffic\s+Notif\.|Window\s+Location|\(M/D\) Time|^\s*(?:NIST TN 22\S*|July(?: 2023)?|A-\d+)\s*$")


def parse_a2_rows(pages: list[str]) -> list[dict]:
    """Every Table A-2 row with its PDF page, printed page, columns and full wrapped text."""
    start = next(i for i, page in enumerate(pages) if re.search(r"Table A-2\. NETTRA data\.\s*$", page, re.M))
    end = next(i for i, page in enumerate(pages) if i > start and "Appendix B. Roadway Characteristics" in page)
    rows: list[dict] = []
    obs_col = None
    for index in range(start, end):
        page = pages[index]
        label = re.search(r"^\s*(A-\d+)(?:\s|$)", page, re.M)
        printed = f"A-{index + 1 - 12}"  # the A-2 pages carry a fixed 12-page front-matter offset
        if label and label.group(1) != printed:
            raise SourceError(f"unexpected printed page {label.group(1)} on PDF page {index + 1}")
        for line in page.splitlines():
            if "NETTRA Observations" in line:
                obs_col = line.index("NETTRA Observations")
                continue
            if not line.strip() or A2_SKIP.search(line):
                continue
            match = A2_ROW.match(line)
            if match:
                line = line.replace("×", " ")
                tail = A2_TAIL.search(line)
                if not tail or obs_col is None:
                    raise SourceError(f"unparseable Table A-2 row on PDF page {index + 1}: {line[:60]!r}")
                point = A2_POINT.search(line, match.end())
                # The observation starts at the cell start (after a column gap) nearest the header's text column.
                floor = point.end() if point else match.end()
                starts = [m.end() for m in re.finditer(r"\s+(?=\S)", line[:tail.start()]) if m.end() > floor]
                starts = starts[:1] + [pos for pos in starts[1:] if line[pos - 2:pos].isspace()]
                cut = min(starts, key=lambda pos: abs(pos - obs_col)) if starts else floor
                rows.append({
                    "ordinal": len(rows) + 1, "pdf_page": index + 1, "printed_page": printed,
                    "day": int(match.group(1)), "time": match.group(2), "window_min": int(match.group(3)),
                    "time_source": match.group(4),
                    "lat": point.group(1) if point else None, "lon": point.group(2) if point else None,
                    "source_number": tail.group(1), "info_source": tail.group(2),
                    "text": A2_SPILL.sub("", line[cut:tail.start()].strip()),
                })
            elif rows:
                rows[-1]["text"] += " " + A2_PAGE_MARKS.sub(" ", line)
    for row in rows:
        row["text"] = normalize_text(row["text"])
    return rows


def a2_channel(row: dict) -> str | None:
    if row["info_source"] == "Radio Log":
        return "radio"
    if re.fullmatch(r"911-\d+-\d+", row["info_source"]):
        return "911"
    return None


def build_a2(pages: list[str]) -> tuple[list[dict], dict]:
    rows = parse_a2_rows(pages)
    kept: dict[tuple, dict] = {}
    dropped = {"info_source_not_911_or_radio_log": 0, "duplicate_quote_merged": 0}
    for row in rows:
        channel = a2_channel(row)
        if channel is None:
            dropped["info_source_not_911_or_radio_log"] += 1
            continue
        sha12 = text_sha12(row["text"])
        key = (row["day"], row["time"], row["source_number"], sha12)
        road, residential = extract_road(row["text"])
        decimals = RESIDENTIAL_COORD_DECIMALS if residential else COORD_DECIMALS
        coord = rounded_coord(row["lat"], row["lon"], decimals)
        if key in kept:
            dropped["duplicate_quote_merged"] += 1
            kept[key]["_coords"].add(tuple(coord) if coord else None)
            continue
        item = make_item(
            f"nist-a2-{row['ordinal']}", utc_at(row["day"], row["time"]),
            "minute" if row["window_min"] == 0 else "approximate", channel, categorize(row["text"]), road,
            coord, "reported",
            f"{SUP_URL}#page={row['pdf_page']}; Table A-2; p. {row['printed_page']}; source {row['source_number']}",
            sha12,
        )
        item["_coords"] = {tuple(coord) if coord else None}
        kept[key] = item
    items = []
    for item in kept.values():
        coords = item.pop("_coords")
        if len(coords) > 1:
            # One quote listed at several places: no single point is carried forward.
            item["coord"] = None
        items.append(item)
    stats = {"rows_parsed": len(rows), "rows_kept": len(items), "rows_dropped": dropped}
    return items, stats


# --- Table K-1 ----------------------------------------------------------------------------

K1_ROW = re.compile(r"^\s*(\d{1,3})\s+(Entrap|Med|Asst|Pick-up)\s")
K1_TIME = re.compile(r"(?<![\d.:])(\d{2}:\d{2})(?![\d:])")
K1_POINT = re.compile(r"(\d{1,2}\.\d{6})\s+(-?\d{1,3}\.\d{6})\s*$")
K1_CLASS_CATEGORY = {"Entrap": "trapped", "Med": "help_needed", "Asst": "help_needed", "Pick-up": "help_needed"}


def build_k1(pages: list[str]) -> tuple[list[dict], dict]:
    start = next(i for i, page in enumerate(pages)
                 if re.search(r"^\s*Table K-1\. List of evacuation assistance", page, re.M) and "....." not in page)
    end = next((i for i, page in enumerate(pages) if i > start and re.search(r"^Appendix L\.", page, re.M)), len(pages))
    rows: list[dict] = []
    for index in range(start, end):
        label = re.search(r"^\s*(K-\d+)\s*$", pages[index], re.M)
        for line in pages[index].splitlines():
            match = K1_ROW.match(line)
            if match:
                rows.append({"event": int(match.group(1)), "class": match.group(2), "line": line,
                             "pdf_page": index + 1, "printed_page": label.group(1) if label else None,
                             "text": line})
            elif rows and line.strip() and rows[-1]["pdf_page"] == index + 1 and not label_line(line):
                rows[-1]["text"] += " " + line
    items, dropped = [], {"no_time_of_first_datapoint": 0, "duplicate_event_id": 0}
    seen = set()
    # K-1 is sorted by first datapoint and gives no date; a clock time that runs backwards
    # by more than an hour after a late-evening row is read as the next day (11/9).
    day, last_minute = 8, 0
    for row in rows:
        if row["event"] in seen:
            dropped["duplicate_event_id"] += 1
            continue
        seen.add(row["event"])
        point = K1_POINT.search(row["line"])
        times = K1_TIME.findall(row["line"][:point.start()] if point else row["line"])
        if not times:
            dropped["no_time_of_first_datapoint"] += 1
            continue
        hours, minutes = (int(part) for part in times[0].split(":"))
        minute = hours * 60 + minutes
        if minute < last_minute - 60:
            if day == 9:
                raise SourceError(f"Table K-1 event {row['event']} breaks chronological order")
            day = 9
        last_minute = minute
        items.append(make_item(
            f"nist-k1-{row['event']}", utc_at(day, times[0]), "approximate", "rescue",
            K1_CLASS_CATEGORY[row["class"]], None,
            rounded_coord(*point.groups()) if point else None, "reconstructed",
            f"{SUP_URL}#page={row['pdf_page']}; Table K-1; p. {row['printed_page']}; EA/R event {row['event']}",
            text_sha12(row["text"]),
        ))
    if sorted(seen) != list(range(1, len(seen) + 1)):
        raise SourceError("Table K-1 event IDs are not a contiguous 1..N sequence")
    return items, {"rows_parsed": len(rows), "rows_kept": len(items), "rows_dropped": dropped}


def label_line(line: str) -> bool:
    return bool(re.fullmatch(r"\s*(?:[A-Z]-\d+|NIST TN 2252 sup|July 2023|\d+)\s*", line))


# --- Main report Tables 10 and 13 ---------------------------------------------------------

T10_ROW = re.compile(r"^\s{0,4}(\d{2}:\d{2})(?:\s(\d{2}:\d{2}))?\s+(\S.*)$")
T13_ROW = re.compile(r"^\s{0,4}(\d{2}:\d{2})(–)?\s+(\S.*)?$")


def table_lines(pages: list[str], title: str, stop: str) -> list[tuple[int, str]]:
    start = next(i for i, page in enumerate(pages) if re.search(rf"^\s*{re.escape(title)}\s*$", page, re.M))
    out: list[tuple[int, str]] = []
    started = False
    for index in range(start, len(pages)):
        for line in pages[index].splitlines():
            if not started:
                started = title in line
                continue
            if re.match(stop, line.strip()):
                return out
            if line.strip() and not label_line(line) and "NIST TN 2252" not in line and "July 2023" not in line:
                out.append((index + 1, line))
    raise SourceError(f"end of {title} not found")


def strip_sources(line: str) -> str:
    """Drop the right-hand Source # column (2+ spaces then a code-like cell)."""
    parts = re.split(r"\s{2,}", line.strip())
    return " ".join(parts[:-1]) if len(parts) > 1 else parts[0]


def build_timeline(pages: list[str], table: str) -> tuple[list[dict], dict]:
    if table == "10":
        lines = table_lines(pages, "Table 10. Notification timeline summary.", r"6\.3\. Analysis")
        row_re, channel, prefix = T10_ROW, "notification", "nist-t10"
    else:
        lines = table_lines(pages, "Table 13. Paradise evacuation summary timeline.", r"7\.2\.3\.")
        row_re, channel, prefix = T13_ROW, "evacuation", "nist-t13"
    rows: list[dict] = []
    for pdf_page, line in lines:
        if line.strip().startswith(("Time Range", "Time ")) and ("Source" in line or "Fire" in line):
            continue
        match = row_re.match(line)
        if match:
            ranged = bool(match.group(2))
            body = match.group(3) or ""
            rows.append({"time": match.group(1), "ranged": ranged, "pdf_page": pdf_page,
                         "text": strip_sources(body) if table == "10" else body})
        elif rows:
            body = re.sub(r"^\s*\d{2}:\d{2}\s", " ", line)  # second half of a wrapped "13:15–13:45" range
            rows[-1]["text"] += " " + (strip_sources(body) if table == "10" else body.strip())
    items = []
    for ordinal, row in enumerate(rows, start=1):
        text = normalize_text(row["text"])
        category = categorize(text)
        road, _ = extract_road(text)  # timeline rows carry no point
        precision = "approximate" if row["ranged"] or table == "13" else "minute"
        page_label = main_page_label(pages[row["pdf_page"] - 1])
        items.append(make_item(
            f"{prefix}-{ordinal}", utc_at(8, row["time"]), precision, channel, category, road, None,
            "reconstructed", f"{MAIN_URL}#page={row['pdf_page']}; Table {table}; p. {page_label}; row {ordinal}",
            text_sha12(text),
        ))
    return items, {"rows_parsed": len(rows), "rows_kept": len(items), "rows_dropped": {}}


def main_page_label(page: str) -> str:
    numbers = re.findall(r"^\s{20,}(\d{1,3})\s*$", page, re.M)
    return numbers[-1] if numbers else "?"


# --- Assembly -----------------------------------------------------------------------------

def build(cache_dir: Path) -> dict:
    sup_path, sup_record = fetch(cache_dir, "sup")
    main_path, main_record = fetch(cache_dir, "main")
    sup_pages, main_pages = pdf_pages(sup_path), pdf_pages(main_path)
    tables = {
        "Table A-2 (911 and Radio Log rows)": build_a2(sup_pages),
        "Table K-1": build_k1(sup_pages),
        "Table 10": build_timeline(main_pages, "10"),
        "Table 13": build_timeline(main_pages, "13"),
    }
    items = [item for table_items, _ in tables.values() for item in table_items]
    items.sort(key=lambda item: (item["at"], item["id"]))
    if len({item["id"] for item in items}) != len(items):
        raise SourceError("duplicate ground-record item IDs")
    return {
        "dataset": "Camp Fire 2018 de-identified ground record: NIST 911, radio-log, rescue and timeline rows",
        "source_url": SUP_URL,
        "source_sha256": sup_record["sha256"],
        "sources": [
            {**sup_record, "tables": ["A-2", "K-1"]},
            {**main_record, "tables": ["10", "13"]},
        ],
        "licence": "NIST technical notes are US government works (public domain in the US); cite NIST TN 2252 and TN 2252sup.",
        "generator": f"tools/camp_ground_record.py ({NORMALIZER_VERSION})",
        "time_zone": "UTC",
        "source_time_zone": "America/Los_Angeles (Pacific Standard Time, UTC-08:00 on 2018-11-08/09)",
        "time_conversion": "at = source clock time on the source date + 8 h; source rows are at 1-minute resolution",
        "coordinate_order": "longitude, latitude",
        "coordinate_crs": "EPSG:4326",
        "coordinate_precision": "rounded to 3 decimal places (about 100 m), or 2 (about 1 km) for rows naming a residential street; "
                                "null when absent or when one quote is listed at several points",
        "interpretation": (
            "Rows are NIST's retrospective transcription of recordings and interviews, not a CAD export, and cover a "
            "sample of calls. 'reported' rows are Table A-2 observations whose Info. Source is a 911 call or the "
            "radio log; 'reconstructed' rows come from NIST summary tables (K-1, main Tables 10 and 13). "
            "time_precision 'approximate' marks a non-zero observation window, a time range (start time kept) or a "
            "summary-table time. Table K-1 gives clock times only and is sorted chronologically, so rows after the "
            "23:30 row whose times run backwards are dated 11/9. K-1 times are each event's first datapoint."
        ),
        "de_identification": (
            "No source free text, names, house numbers, addresses, ages or medical details are kept. summary is a "
            "template of channel, category and road name; category comes from keyword rules in the generator; "
            "text_sha12 is a 12-hex SHA-256 prefix of the whitespace-normalized source row text, kept only to merge "
            "duplicate quotes of one observation. road_name is limited to the MAIN_ROADS allow-list in the "
            "generator (main roads, arterials, three collectors and the state highways); any other road is null. "
            "When a row names a road outside that list (a residential street), its point is rounded to 2 decimals "
            "(about 1 km) instead of 3."
        ),
        "extraction": {table: stats for table, (_, stats) in tables.items()},
        "items": items,
    }


def encode(record: dict) -> bytes:
    head = {key: value for key, value in record.items() if key != "items"}
    text = json.dumps(head, indent=2, ensure_ascii=False)[:-2]
    lines = ",\n".join("    " + json.dumps(item, ensure_ascii=False, separators=(",", ":")) for item in record["items"])
    return f'{text},\n  "items": [\n{lines}\n  ]\n}}\n'.encode()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cache-dir", type=Path, required=True,
                        help="directory outside the repository for the downloaded PDFs")
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    if args.cache_dir.resolve().is_relative_to(repo):
        parser.error("--cache-dir must be outside the repository")
    record = build(args.cache_dir)
    args.output.write_bytes(encode(record))
    print(json.dumps(record["extraction"], indent=2))


if __name__ == "__main__":
    main()
