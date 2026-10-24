"""Proposal diffs and the pre-approved reroute policy (ADR 0012).

Contract: docs/live-reports.md "Proposals and the approval policy". JSON ``from``/``to`` are
``before``/``after`` here (``from`` is a Python keyword).
"""

from __future__ import annotations

from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

from .fire import FireEstimate
from .planner import GuidanceLevel, ZoneGuidance

ChangeKind = Literal["reroute", "level_change", "new", "cleared"]
Cause = Literal["road_block", "fire", "manual"]
AUTO_APPROVE_CAUSES: frozenset[str] = frozenset({"road_block", "fire"})
AUTO_REPLAN_MIN_INTERVAL_S = 30
"""Minimum wall seconds between automatic replans per incident."""


@dataclass(frozen=True)
class GuidanceSummary:
    """What a change compares: the published (or proposed) state of one zone."""

    level: GuidanceLevel
    destination_id: str | None
    via: tuple[str, ...]
    no_route: bool


@dataclass(frozen=True)
class Change:
    zone_id: str
    kind: ChangeKind
    before: GuidanceSummary | None
    """JSON ``from``; None for ``new`` when the zone had no published entry."""
    after: ZoneGuidance
    """JSON ``to``; ``level == "none"`` for ``cleared``."""


def summarize(guidance: ZoneGuidance) -> GuidanceSummary:
    """The comparable fields of a planner result."""
    return GuidanceSummary(
        level=guidance.level,
        destination_id=guidance.destination_id,
        via=tuple(guidance.via),
        no_route=guidance.no_route,
    )


def _kind(before: GuidanceSummary | None, after: GuidanceSummary) -> ChangeKind | None:
    was = before.level if before is not None else "none"
    if was == "none":
        return "new" if after.level != "none" else None
    if after.level == "none":
        return "cleared"
    if was != after.level:
        return "level_change"
    assert before is not None
    if (before.destination_id != after.destination_id or tuple(before.via) != tuple(after.via)
            or before.no_route != after.no_route):
        return "reroute"
    return None


def diff(published: Mapping[str, GuidanceSummary], proposed: Sequence[ZoneGuidance]) -> list[Change]:
    """Changes from ``published`` (zone id -> current published summary) to ``proposed``.

    ``new``: no entry or published ``none``, proposed not ``none``. ``cleared``: published not
    ``none``, proposed ``none``. ``level_change``: both not ``none``, levels differ. ``reroute``:
    same non-``none`` level, ``destination_id``, ``via`` or ``no_route`` differ. ETA alone is
    not a change. Output follows ``proposed`` order.
    """
    changes: list[Change] = []
    for g in proposed:
        before = published.get(g.zone_id)
        kind = _kind(before, summarize(g))
        if kind is not None:
            changes.append(Change(zone_id=g.zone_id, kind=kind, before=before, after=g))
    return changes


def _causes_qualify(causes: Collection[str]) -> bool:
    return bool(causes) and all(c in AUTO_APPROVE_CAUSES for c in causes)


def is_auto_approvable(changes: Sequence[Change], causes: Collection[str]) -> bool:
    """True iff ``changes`` is non-empty, every change is ``reroute``, and ``causes`` is
    non-empty and a subset of AUTO_APPROVE_CAUSES."""
    return bool(changes) and all(c.kind == "reroute" for c in changes) and _causes_qualify(causes)


def partition(changes: Sequence[Change], causes: Collection[str]) -> tuple[list[Change], list[Change]]:
    """Split into ``(auto_approved, needs_controller)``: reroutes go to the first list when
    ``causes`` qualify; everything else (and everything for ``manual``) to the second."""
    if not _causes_qualify(causes):
        return [], list(changes)
    auto = [c for c in changes if c.kind == "reroute"]
    rest = [c for c in changes if c.kind != "reroute"]
    return auto, rest


_KIND_TEXT: dict[str, tuple[str, str]] = {
    "reroute": ("zone rerouted", "zones rerouted"),
    "level_change": ("zone changes level", "zones change level"),
    "new": ("zone gets new guidance", "zones get new guidance"),
    "cleared": ("zone cleared", "zones cleared"),
}
_CAUSE_TEXT = {"road_block": "a confirmed road block", "fire": "the updated fire estimate", "manual": "a controller request"}


def template_rationale(changes: Sequence[Change], causes: Collection[str], fire: FireEstimate) -> str:
    """Deterministic rationale used when no LLM text is available (``generated_by: "template"``)."""
    if not changes:
        return f"No guidance changes. Fire: {fire.label}."
    counts: dict[str, int] = {}
    for c in changes:
        counts[c.kind] = counts.get(c.kind, 0) + 1
    parts = []
    for kind in ("level_change", "new", "reroute", "cleared"):
        n = counts.get(kind)
        if n:
            one, many = _KIND_TEXT[kind]
            parts.append(f"{n} {one if n == 1 else many}")
    evac = sum(1 for c in changes if c.after.level == "evacuate_now")
    no_route = sum(1 for c in changes if c.after.no_route)
    cause_text = " and ".join(_CAUSE_TEXT.get(c, c) for c in sorted(set(causes))) or "a replan"
    text = f"{', '.join(parts).capitalize()} after {cause_text}. Fire: {fire.label}."
    if evac:
        text += f" {evac} changed zone{'s' if evac != 1 else ''} at evacuate now."
    if no_route:
        text += f" {no_route} changed zone{'s' if no_route != 1 else ''} with no open route."
    return text
