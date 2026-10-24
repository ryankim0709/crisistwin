"""CrisisTwin incident-intel Actor: fetch and clean public pages. Never calls an LLM.

Contract: docs/incident-intel.md section (a). Page content is untrusted data; this
Actor only fetches, strips markup and hashes it.
"""
import asyncio
import hashlib
import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit
from urllib.robotparser import RobotFileParser

import httpx
from apify import Actor
from bs4 import BeautifulSoup

USER_AGENT = "CrisisTwin-IncidentIntel/0.1 (wildfire planning research)"
TIMEOUT_S = 20
DELAY_S = 1.0
RETRIES = 3  # extra attempts after a 429 or 5xx
RETRY_BACKOFF = 3.0  # attempt n waits DELAY_S * RETRY_BACKOFF**n: 1, 3, 9, 27 s
MAX_BODY_BYTES = 3 * 1024 * 1024
MAX_TEXT_CHARS = 50_000
CDX_URL = "https://web.archive.org/cdx/search/cdx"
CDX_FIELDS = ["timestamp", "original", "statuscode", "mimetype", "digest"]
KINDS = {"agency", "road_status", "shelter", "news", "other"}
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")
DROP_TAGS = ("script", "style", "noscript", "nav", "footer", "form")
TEXT_TYPES = ("text/html", "text/plain")


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_utc(value: Any) -> datetime:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", value):
        raise ValueError(f"time must be UTC YYYY-MM-DDTHH:MM:SSZ, got {value!r}")
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def validate_input(raw: Any) -> dict:
    """Return a normalised copy of the input or raise ValueError with a clear message."""
    if not isinstance(raw, dict):
        raise ValueError("input must be an object")
    mode = raw.get("mode")
    if mode not in ("live", "archive"):
        raise ValueError("mode must be 'live' or 'archive'")
    sources = raw.get("sources")
    if not isinstance(sources, list) or not 1 <= len(sources) <= 20:
        raise ValueError("sources must be a list of 1..20 items")
    clean = []
    for i, s in enumerate(sources):
        if not isinstance(s, dict):
            raise ValueError(f"sources[{i}] must be an object")
        sid, url, kind = s.get("id"), s.get("url"), s.get("kind")
        if not isinstance(sid, str) or not SLUG.match(sid):
            raise ValueError(f"sources[{i}].id must match {SLUG.pattern}")
        if not isinstance(url, str) or len(url) > 2000 or urlsplit(url).scheme not in ("http", "https") \
                or not urlsplit(url).netloc:
            raise ValueError(f"sources[{i}].url must be an http(s) URL of at most 2000 characters")
        if kind not in KINDS:
            raise ValueError(f"sources[{i}].kind must be one of {sorted(KINDS)}")
        clean.append({"id": sid, "url": url, "kind": kind})
    out: dict = {"mode": mode, "sources": clean, "window": None}
    for key, default, hi in (("max_documents", 25, 200), ("max_captures_per_source", 10, 50)):
        v = raw.get(key, default)
        if isinstance(v, bool) or not isinstance(v, int) or not 1 <= v <= hi:
            raise ValueError(f"{key} must be an integer 1..{hi}")
        out[key] = v
    if mode == "archive":
        w = raw.get("window")
        if not isinstance(w, dict) or "from" not in w or "to" not in w:
            raise ValueError("archive mode requires window {from, to} in UTC")
        start, end = parse_utc(w["from"]), parse_utc(w["to"])
        if start >= end:
            raise ValueError("window.from must be before window.to")
        out["window"] = {"from": start, "to": end}
    return out


def cdx_params(url: str, window: dict, limit: int) -> dict:
    return {
        "url": url,
        "from": window["from"].strftime("%Y%m%d%H%M%S"),
        "to": window["to"].strftime("%Y%m%d%H%M%S"),
        "output": "json",
        "fl": ",".join(CDX_FIELDS),
        "filter": "statuscode:200",
        "collapse": "digest",
        "limit": str(limit),
    }


def parse_cdx_rows(payload: Any) -> list[dict]:
    """CDX json: first row is the header; an empty result is []. Malformed rows are skipped."""
    if not isinstance(payload, list) or len(payload) < 2:
        return []
    header = payload[0]
    out = []
    for row in payload[1:]:
        if not isinstance(row, list) or len(row) != len(header):
            continue
        rec = dict(zip(header, row))
        if re.fullmatch(r"\d{14}", str(rec.get("timestamp", ""))) and rec.get("original"):
            out.append(rec)
    return out


def wayback_raw_url(timestamp: str, original: str) -> str:
    return f"https://web.archive.org/web/{timestamp}id_/{original}"


def archived_at(timestamp: str) -> str:
    dt = datetime.strptime(timestamp, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def extract_text(html: str) -> tuple[str, str | None, str | None]:
    """Return (text, title, language). Text is visible text, newline-joined, whitespace collapsed."""
    soup = BeautifulSoup(html, "html.parser")
    title = None
    if soup.title and soup.title.string:
        title = re.sub(r"\s+", " ", soup.title.string).strip()[:300] or None
    root = soup.find("html")
    lang = root.get("lang") if root else None
    lang = lang.strip() if isinstance(lang, str) and lang.strip() else None
    for tag in soup(DROP_TAGS):
        tag.decompose()
    lines = (re.sub(r"[ \t\r\f\v\u00a0]+", " ", s).strip() for s in soup.get_text("\n").split("\n"))
    return "\n".join(line for line in lines if line), title, lang


def build_item(*, source: dict, mode: str, url: str, original_url: str, fetched_at: str,
               archived: str | None, http_status: int, content_type: str, body: str,
               wayback_digest: str | None = None) -> dict:
    text, title, lang = extract_text(body)
    truncated = len(text) > MAX_TEXT_CHARS
    if truncated:
        text = text[:MAX_TEXT_CHARS]
    return {
        "kind": "crisistwin_intel_document",
        "schema_version": "1.0.0",
        "source_id": source["id"],
        "source_kind": source["kind"],
        "mode": mode,
        "url": url,
        "original_url": original_url,
        "fetched_at": fetched_at,
        "archived_at": archived,
        "http_status": http_status,
        "content_type": content_type,
        "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "title": title,
        "text": text,
        "text_truncated": truncated,
        "language": lang,
        "wayback_digest": wayback_digest,
    }


class Fetcher:
    def __init__(self, client: httpx.AsyncClient):
        self.client = client
        self._last = 0.0

    async def get(self, url: str, **kw) -> httpx.Response:
        """GET with a 1 s gap between requests; 429/5xx are retried with backoff (Wayback throttles)."""
        loop = asyncio.get_running_loop()
        for attempt in range(RETRIES + 1):
            wait = DELAY_S * (RETRY_BACKOFF ** attempt) - (loop.time() - self._last)
            if wait > 0:
                await asyncio.sleep(wait)
            try:
                resp = await self.client.get(url, **kw)
            finally:
                self._last = loop.time()
            if resp.status_code != 429 and resp.status_code < 500:
                break
        return resp

    async def fetch_page(self, url: str) -> tuple[httpx.Response, str, str]:
        """Return (response, content_type, decoded body) or raise ValueError when skipped."""
        resp = await self.get(url)
        resp.raise_for_status()
        ctype = resp.headers.get("content-type", "").split(";")[0].strip().lower()
        if ctype not in TEXT_TYPES:
            raise ValueError(f"unsupported content type {ctype or 'unknown'}")
        if len(resp.content) > MAX_BODY_BYTES:
            raise ValueError("body larger than 3 MB")
        return resp, ctype, resp.text


async def robots_allows(fetcher: Fetcher, url: str) -> bool:
    parts = urlsplit(url)
    robots_url = f"{parts.scheme}://{parts.netloc}/robots.txt"
    parser = RobotFileParser()
    try:
        resp = await fetcher.get(robots_url)
    except httpx.HTTPError:
        return False  # cannot confirm permission, so do not fetch
    if resp.status_code in (401, 403):
        return False
    if resp.status_code >= 400:
        return True  # no robots.txt
    parser.parse(resp.text.splitlines())
    return parser.can_fetch(USER_AGENT, url)


async def live_documents(fetcher: Fetcher, source: dict, budget: int) -> list[dict]:
    if not await robots_allows(fetcher, source["url"]):
        raise ValueError("robots.txt disallows or could not be checked")
    resp, ctype, body = await fetcher.fetch_page(source["url"])
    item = build_item(source=source, mode="live", url=str(resp.url), original_url=source["url"],
                      fetched_at=utc_now(), archived=None, http_status=resp.status_code,
                      content_type=ctype, body=body)
    return [item][:budget]


async def archive_documents(fetcher: Fetcher, source: dict, window: dict, limit: int,
                            budget: int) -> list[dict]:
    resp = await fetcher.get(CDX_URL, params=cdx_params(source["url"], window, limit))
    resp.raise_for_status()
    items = []
    for cap in parse_cdx_rows(resp.json())[:min(limit, budget)]:
        raw_url = wayback_raw_url(cap["timestamp"], cap["original"])
        try:
            page, ctype, body = await fetcher.fetch_page(raw_url)
        except (httpx.HTTPError, ValueError) as exc:
            Actor.log.warning(f"{source['id']}: skipped capture {cap['timestamp']}: {exc}")
            continue
        items.append(build_item(
            source=source, mode="archive", url=raw_url, original_url=cap["original"],
            fetched_at=utc_now(), archived=archived_at(cap["timestamp"]),
            http_status=page.status_code, content_type=ctype, body=body,
            wayback_digest=cap.get("digest") or None))
    return items


async def main() -> None:
    async with Actor:
        try:
            cfg = validate_input(await Actor.get_input())
        except ValueError as exc:
            await Actor.fail(status_message=f"Invalid input: {exc}")
            return
        pushed = 0
        headers = {"User-Agent": USER_AGENT}
        async with httpx.AsyncClient(headers=headers, timeout=TIMEOUT_S, follow_redirects=True) as client:
            fetcher = Fetcher(client)
            for source in cfg["sources"]:
                budget = cfg["max_documents"] - pushed
                if budget <= 0:
                    break
                try:
                    if cfg["mode"] == "live":
                        docs = await live_documents(fetcher, source, budget)
                    else:
                        docs = await archive_documents(fetcher, source, cfg["window"],
                                                       cfg["max_captures_per_source"], budget)
                except (httpx.HTTPError, ValueError) as exc:
                    Actor.log.warning(f"{source['id']}: source skipped: {exc}")
                    continue
                for doc in docs:
                    await Actor.push_data(doc)
                    pushed += 1
                Actor.log.info(f"{source['id']}: {len(docs)} documents")
        await Actor.set_status_message(f"{pushed} documents")
