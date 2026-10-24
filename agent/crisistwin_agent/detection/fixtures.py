"""Recorded-fixture detection feed, so the demo runs offline and in CI.

Nothing this module returns is an observation. Every detection carries
``Evidence(kind="recorded-fixture")``, whose ``label()`` reads
"RECORDED FIXTURE - not live data", so no UI, report, or advisory can show
fixture output as if a satellite had seen it.

The loader is deliberately strict about provenance: a fixture file must declare
itself synthetic (``data_kind`` is ``"synthetic-fixture"`` and
``is_observational`` is ``false``) or it is refused. A file that claims to be
real observations is not quietly re-labelled as a fixture, and a fixture is
never quietly promoted to an observation.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..domain import AreaOfInterest, DetectionConfidence, Evidence, FireDetection, GeoPoint, utc_now
from ..ports import PortUnavailableError

#: Packaged demo fixture: ``agent/fixtures/berkeley_detections.json``.
BERKELEY_FIXTURE_PATH: Path = Path(__file__).resolve().parents[2] / "fixtures" / "berkeley_detections.json"

#: The marker a file must carry before this module will load it.
REQUIRED_DATA_KIND = "synthetic-fixture"

_VALID_CONFIDENCES: frozenset[str] = frozenset({"low", "nominal", "high"})

_FIXTURE_WARNING = "RECORDED FIXTURE - not live data and not a record of any real fire."


class FixtureDetectionSource:
    """:class:`~crisistwin_agent.ports.DetectionSource` backed by a JSON file.

    Same contract as the live source: an empty list means the fixture held
    nothing inside the area or the time window, while a missing file, invalid
    JSON, or a file that does not declare itself synthetic raises
    :class:`PortUnavailableError`.
    """

    source_id: str = "recorded-fixture"

    def __init__(self, path: str | Path = BERKELEY_FIXTURE_PATH, *, source_name: str | None = None) -> None:
        self.path = Path(path).expanduser().resolve()
        self.source_id = f"recorded-fixture:{self.path.stem}"
        self.source_name = source_name or f"CrisisTwin recorded fixture ({self.path.name}) - not live data"

    def fetch(self, area: AreaOfInterest, since: datetime) -> list[FireDetection]:
        """Fixture detections inside ``area`` recorded at or after ``since`` (UTC)."""
        if since.tzinfo is None:
            raise ValueError("since must be timezone-aware UTC")
        since_utc = since.astimezone(timezone.utc)
        document = self._load()
        evidence = Evidence(
            kind="recorded-fixture",
            source_id=self.source_id,
            source_name=self.source_name,
            retrieved_at=utc_now(),
            source_url=self.path.as_uri(),
            note=f"{_FIXTURE_WARNING} {str(document.get('note', '')).strip()}".strip(),
        )

        rows = document.get("detections")
        if not isinstance(rows, list):
            raise PortUnavailableError(self.source_id, f"{self.path} has no 'detections' list")

        detections = [self._to_detection(row, index, evidence) for index, row in enumerate(rows)]
        inside = [d for d in detections if d.detected_at >= since_utc and area.contains(d.location)]
        inside.sort(key=lambda d: (d.detected_at, d.location.latitude, d.location.longitude))
        return inside

    def _load(self) -> dict[str, Any]:
        try:
            raw = self.path.read_text(encoding="utf-8")
        except OSError as error:
            raise PortUnavailableError(self.source_id, f"cannot read fixture {self.path}: {error}") from error
        try:
            document = json.loads(raw)
        except json.JSONDecodeError as error:
            raise PortUnavailableError(self.source_id, f"fixture {self.path} is not valid JSON: {error}") from error
        if not isinstance(document, dict):
            raise PortUnavailableError(self.source_id, f"fixture {self.path} must be a JSON object")
        if document.get("data_kind") != REQUIRED_DATA_KIND:
            raise PortUnavailableError(
                self.source_id,
                f"fixture {self.path} must declare \"data_kind\": \"{REQUIRED_DATA_KIND}\"; "
                f"got {document.get('data_kind')!r}",
            )
        if document.get("is_observational") is not False:
            raise PortUnavailableError(
                self.source_id,
                f"fixture {self.path} must declare \"is_observational\": false; this loader only serves "
                "recorded fixtures and will not relabel observations",
            )
        return document

    def _to_detection(self, row: Any, index: int, evidence: Evidence) -> FireDetection:
        where = f"{self.path.name} detections[{index}]"
        if not isinstance(row, dict):
            raise PortUnavailableError(self.source_id, f"{where} is not an object")
        try:
            location = GeoPoint(latitude=float(row["latitude"]), longitude=float(row["longitude"]))
        except (KeyError, TypeError, ValueError) as error:
            raise PortUnavailableError(self.source_id, f"{where} has unusable coordinates: {error}") from error

        return FireDetection(
            detected_at=self._parse_timestamp(row.get("detected_at"), where),
            location=location,
            satellite=str(row.get("satellite", "fixture")),
            instrument=str(row.get("instrument", "fixture")),
            confidence=self._parse_confidence(row.get("confidence"), where),
            brightness_kelvin=self._parse_optional_float(row.get("brightness_kelvin"), "brightness_kelvin", where),
            frp_megawatts=self._parse_optional_float(row.get("frp_megawatts"), "frp_megawatts", where),
            evidence=evidence,
            external_id=str(row["external_id"]) if row.get("external_id") is not None else None,
        )

    def _parse_timestamp(self, value: Any, where: str) -> datetime:
        if not isinstance(value, str):
            raise PortUnavailableError(self.source_id, f"{where} is missing an ISO-8601 'detected_at'")
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError as error:
            raise PortUnavailableError(self.source_id, f"{where} has unparseable detected_at {value!r}") from error
        if parsed.tzinfo is None:
            raise PortUnavailableError(
                self.source_id, f"{where} detected_at {value!r} has no time zone; fixtures must state UTC"
            )
        return parsed.astimezone(timezone.utc)

    def _parse_confidence(self, value: Any, where: str) -> DetectionConfidence:
        text = str(value).strip().lower()
        if text not in _VALID_CONFIDENCES:
            raise PortUnavailableError(
                self.source_id, f"{where} confidence {value!r} is not one of {sorted(_VALID_CONFIDENCES)}"
            )
        # Narrowed by the membership check above.
        return text  # type: ignore[return-value]

    def _parse_optional_float(self, value: Any, field_name: str, where: str) -> float | None:
        # A missing or null value means "not reported" and stays None, never 0.
        if value is None or value == "":
            return None
        try:
            return float(value)
        except (TypeError, ValueError) as error:
            raise PortUnavailableError(self.source_id, f"{where} has unparseable {field_name} {value!r}") from error
