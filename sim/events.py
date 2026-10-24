"""Resolve historical road events (NIST-reviewed closures, soft closures, contraflow) to network edges.

Source events name roads ("Pearson Rd at Sawmill Rd") and may carry an unsnapped
observation point. Snapping is a derived step: it never invents a location beyond the
rules below, and every event reports how it was matched. Unresolved events pass
through as timeline-only events without edge_ids. Alert events (`alert_sent`) are
left to `sim.network.load_alert_events`. Every other non-road event (shelter open/close,
fire_arrival, burnover, orders, ...) passes through unchanged, with no snapping.

Matching rules, in order:
1. Point and road name: nearest edge of the named road within SNAP_RADIUS_M, both directions.
2. Road name and a cross street: the junction node(s) of both roads, if they lie within
   JUNCTION_CLUSTER_M of each other; the named road's edges at that junction.
3. Point only (no usable name match): nearest edge of any road within SNAP_RADIUS_M, low confidence.
4. Otherwise unresolved.
Contraflow uses the named road's edges within an extent of the point (or of TOWN_REFERENCE_LONLAT
when there is no point) and keeps the outbound direction (see `_outbound`).
"""

from __future__ import annotations

import heapq
import json
import math
import re
from collections.abc import Iterable
from pathlib import Path

from sim.geo import EARTH_RADIUS_M
from sim.history import parse_utc
from sim.traffic import Destination, RoadEdge, RoadNetwork, TrafficEvent

SNAP_RADIUS_M = 150.0  # max distance from a source observation point to a snapped edge
JUNCTION_CLUSTER_M = 300.0  # junction nodes of two named roads must lie this close together, else ambiguous
CONTRAFLOW_POINT_EXTENT_M = 2000.0  # contraflow reach along the named road around a source point
CONTRAFLOW_EXTENT_M = 8000.0  # contraflow reach around TOWN_REFERENCE_LONLAT when the source has no point
TOWN_REFERENCE_LONLAT = (-121.60, 39.76)  # central Paradise; evacuation flows away from it
SOFT_CLOSURE_CAPACITY_FACTOR = 0.5  # "soft closure, allowing vehicles to pass if needed"

CLOSURE_TYPES = ("road_blocked", "road_closed")
SOFT_CLOSURE_TYPES = ("road_access_restricted",)
CONTRAFLOW_TYPES = ("contraflow_reported", "contraflow_observed")
ALERT_TYPES = ("alert_sent",)
REOPEN_TYPES = ("road_reopened",)
ROAD_EVENT_TYPES = CLOSURE_TYPES + SOFT_CLOSURE_TYPES + CONTRAFLOW_TYPES + REOPEN_TYPES  # only these are snapped

ASSUMPTIONS = [
    f"Road events are snapped to OSM edges by road name within {SNAP_RADIUS_M:.0f} m of the source observation "
    "point, or at the junction with a named cross street; the snap is derived, not part of the source.",
    f"A soft closure (access restricted, vehicles may pass) is modelled as capacity x {SOFT_CLOSURE_CAPACITY_FACTOR}.",
    f"Contraflow applies to the named road within {CONTRAFLOW_POINT_EXTENT_M:.0f} m of the source point, or within "
    f"{CONTRAFLOW_EXTENT_M:.0f} m of central Paradise {list(TOWN_REFERENCE_LONLAT)} when there is no point. The "
    "outbound direction is the stated direction (e.g. southbound) if any, else the direction that reduces free-flow "
    "time to the nearest exit.",
    "A closure at a point closes the nearest segment of the named road in both directions unless the source names "
    "a direction (NB/SB/EB/WB).",
]

_ABBREV = {
    "rd": "road", "st": "street", "ave": "avenue", "av": "avenue", "ln": "lane", "dr": "drive",
    "hwy": "highway", "blvd": "boulevard", "ct": "court", "pkwy": "parkway", "wy": "way",
}
_DIRECTIONS = {
    "nb": "north", "northbound": "north", "sb": "south", "southbound": "south",
    "eb": "east", "eastbound": "east", "wb": "west", "westbound": "west",
}
_DROP_SUFFIX = ("road",)  # OSM mixes "Skyway" and "Skyway Road"; other street types stay distinctive
_UNSPECIFIED = ("unspecified", "name unspecified")


def _tokens(text: str) -> list[str]:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).split()


def canonical_road_name(name: str) -> str:
    """'Skyway NB' -> 'skyway', 'Bruce [Rd]' -> 'bruce', 'Pearson Road' -> 'pearson'."""
    tokens = [_ABBREV.get(t, t) for t in _tokens(name) if t not in _DIRECTIONS]
    while len(tokens) > 1 and tokens[-1] in _DROP_SUFFIX:
        tokens.pop()
    return " ".join(tokens)


def direction_hint(text: str) -> str | None:
    hints = {_DIRECTIONS[t] for t in _tokens(text) if t in _DIRECTIONS}
    return hints.pop() if len(hints) == 1 else None


def parse_road_text(road_name: str, has_point: bool) -> tuple[list[str], list[str]]:
    """(primary roads, cross streets) from a source road description."""
    text = road_name.replace("[", "").replace("]", "")
    if any(u in text.lower() for u in _UNSPECIFIED):
        return [], []
    if " between " in text:
        primary, rest = text.split(" between ", 1)
        return [primary], [c for c in re.split(r"\s+and\s+", rest) if c.strip()]
    if " at " in text:
        primary, cross = text.split(" at ", 1)
        return [primary], [cross]
    if "," in text:
        return [n for n in re.split(r",\s*(?:and\s+)?|\s+and\s+", text) if n.strip()], []
    if " and " in text:
        a, b = text.split(" and ", 1)
        # With a point, "A and B" is read as the junction of A with cross street B; without, as two roads.
        return ([a], [b]) if has_point else ([a, b], [])
    return [text], []


class _Geo:
    """Local metric helpers around the network (equirectangular, adequate at incident scale)."""

    def __init__(self, network: RoadNetwork):
        lats = [lat for _, lat in network.nodes.values()]
        self.ky = math.radians(1) * EARTH_RADIUS_M
        self.kx = self.ky * math.cos(math.radians((min(lats) + max(lats)) / 2))

    def dist(self, a: tuple[float, float], b: tuple[float, float]) -> float:
        return math.hypot((a[0] - b[0]) * self.kx, (a[1] - b[1]) * self.ky)

    def dist_to_line(self, p: tuple[float, float], coords) -> float:
        px, py = p[0] * self.kx, p[1] * self.ky
        best = math.inf
        pts = [(x * self.kx, y * self.ky) for x, y in coords]
        for (x0, y0), (x1, y1) in zip(pts, pts[1:] or pts):
            dx, dy = x1 - x0, y1 - y0
            f = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((px - x0) * dx + (py - y0) * dy) / (dx * dx + dy * dy)))
            best = min(best, math.hypot(px - x0 - f * dx, py - y0 - f * dy))
        return best


def _heading_ok(edge: RoadEdge, nodes: dict, hint: str | None) -> bool:
    if hint is None:
        return True
    (x0, y0), (x1, y1) = nodes[edge.from_node], nodes[edge.to_node]
    return {"north": y1 > y0, "south": y1 < y0, "east": x1 > x0, "west": x1 < x0}[hint]


def _exit_time_s(network: RoadNetwork, destinations: tuple[Destination, ...]) -> dict[str, float]:
    """Free-flow seconds from each node to the nearest exit (reversed multi-source Dijkstra)."""
    into: dict[str, list[RoadEdge]] = {}
    for e in network.edges:
        into.setdefault(e.to_node, []).append(e)
    dist = {d.node_id: 0.0 for d in destinations}
    heap = [(0.0, n) for n in sorted(dist)]
    heapq.heapify(heap)
    while heap:
        d, v = heapq.heappop(heap)
        if d > dist.get(v, math.inf):
            continue
        for e in into.get(v, ()):
            nd = d + e.length_m / (e.speed_kph / 3.6)
            if nd < dist.get(e.from_node, math.inf):
                dist[e.from_node] = nd
                heapq.heappush(heap, (nd, e.from_node))
    return dist


def resolve_road_events(
    package: Path,
    network: RoadNetwork,
    destinations: tuple[Destination, ...] = (),
) -> tuple[tuple[TrafficEvent, ...], list[dict]]:
    """Every non-alert event in the package's events.jsonl as a TrafficEvent, plus a snapping report.

    Call after `load_road_network(package)`, which verifies the package. `destinations` (the
    exits) decide the outbound direction of contraflow; without them the outbound direction
    is away from TOWN_REFERENCE_LONLAT.
    """
    path = package / "normalized/events.jsonl"
    if not path.exists():
        return (), []
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    return resolve_road_rows(rows, network, destinations)


def resolve_road_rows(
    rows: Iterable[dict],
    network: RoadNetwork,
    destinations: tuple[Destination, ...] = (),
) -> tuple[tuple[TrafficEvent, ...], list[dict]]:
    """`resolve_road_events` for events.jsonl rows already in memory (e.g. `sim.intel.load_intel_rows`).

    Same matching rules, TrafficEvents and report rows; alert rows are skipped.
    """
    geo = _Geo(network)
    nodes = network.nodes
    by_name: dict[str, list[RoadEdge]] = {}
    for e in network.edges:
        by_name.setdefault(canonical_road_name(e.name), []).append(e)
    twin = {(e.segment_id, e.from_node, e.to_node): e for e in network.edges}
    exit_time = _exit_time_s(network, destinations) if destinations else None

    def with_twins(edges: list[RoadEdge]) -> list[RoadEdge]:
        out = {e.id: e for e in edges}
        for e in edges:
            t = twin.get((e.segment_id, e.to_node, e.from_node))
            if t is not None:
                out.setdefault(t.id, t)
        return sorted(out.values(), key=lambda e: e.id)

    def junction(primary: str, cross: str) -> list[str] | None:
        a = {n for e in by_name.get(primary, ()) for n in (e.from_node, e.to_node)}
        b = {n for e in by_name.get(cross, ()) for n in (e.from_node, e.to_node)}
        shared = sorted(a & b)
        if not shared:
            return None
        cx = sum(nodes[n][0] for n in shared) / len(shared)
        cy = sum(nodes[n][1] for n in shared) / len(shared)
        if any(geo.dist(nodes[n], (cx, cy)) > JUNCTION_CLUSTER_M for n in shared):
            return None  # the roads meet in several places; the source does not say which
        return shared

    def outbound(e: RoadEdge, hint: str | None) -> bool:
        if hint is not None:
            return _heading_ok(e, nodes, hint)
        if exit_time is not None:
            return exit_time.get(e.to_node, math.inf) < exit_time.get(e.from_node, math.inf)
        return geo.dist(nodes[e.to_node], TOWN_REFERENCE_LONLAT) > geo.dist(nodes[e.from_node], TOWN_REFERENCE_LONLAT)

    events: list[TrafficEvent] = []
    report: list[dict] = []
    for src in rows:
        if src["type"] in ALERT_TYPES:
            continue
        if src["type"] not in ROAD_EVENT_TYPES:
            events.append(TrafficEvent(
                id=src["event_id"], at=parse_utc(src["occurred_at"]), type=src["type"], label=src["description"],
                evidence_class=src["evidence_class"], time_precision=src["time_precision"],
                source_id=src["source_id"], source_locator=src.get("source_locator"),
            ))
            report.append({
                "event_id": src["event_id"], "at": src["occurred_at"], "source_type": src["type"],
                "engine_type": src["type"], "road_name": (src.get("target") or {}).get("road_name") or "",
                "evidence_class": src["evidence_class"], "status": "not_road", "method": None, "distance_m": None,
                "direction_hint": None, "edge_ids": [], "edge_names": [], "capacity_factor": None,
                "note": "non-road event: passed through without snapping",
            })
            continue
        road_text = (src.get("target") or {}).get("road_name") or ""
        point = tuple(src["geometry"]["coordinates"]) if src.get("geometry") else None
        primaries, crosses = parse_road_text(road_text, point is not None)
        primary_keys = [k for k in (canonical_road_name(n) for n in primaries) if k in by_name]
        cross_keys = [canonical_road_name(n) for n in crosses]
        is_contraflow = src["type"] in CONTRAFLOW_TYPES
        hint = direction_hint(road_text + (" " + src.get("description", "") if is_contraflow else ""))

        chosen: list[RoadEdge] = []
        status, method, distance, note = "unresolved", None, None, ""
        if is_contraflow:
            if point is not None:
                near = [e for k in primary_keys for e in by_name[k] if geo.dist_to_line(point, e.coords) <= SNAP_RADIUS_M]
                if near:
                    center, extent = point, CONTRAFLOW_POINT_EXTENT_M
                    distance = min(geo.dist_to_line(point, e.coords) for e in near)
                    method = f"named road within {CONTRAFLOW_POINT_EXTENT_M:.0f} m of source point"
                else:
                    center = None
                    note = f"no edge of {primaries or 'an unnamed road'} within {SNAP_RADIUS_M:.0f} m of the point"
            else:
                center, extent = TOWN_REFERENCE_LONLAT, CONTRAFLOW_EXTENT_M
                method = f"named roads within {CONTRAFLOW_EXTENT_M:.0f} m of town reference (no source point)"
            if center is not None and primary_keys:
                chosen = [
                    e for k in primary_keys for e in by_name[k]
                    if geo.dist_to_line(center, e.coords) <= extent and outbound(e, hint)
                ]
                status = "snapped" if chosen else "unresolved"
                rule = f"stated direction {hint}bound" if hint else (
                    "toward nearest exit" if exit_time is not None else "away from town reference")
                note = f"outbound = {rule}"
            elif not primary_keys:
                note = f"road name {primaries} not found in network"
        else:
            if point is not None and primary_keys:
                # Divided highways are one-way pairs, so a stated direction picks the carriageway first.
                cands = [
                    (geo.dist_to_line(point, e.coords), e.id, e)
                    for k in primary_keys for e in by_name[k] if _heading_ok(e, nodes, hint)
                ]
                d, _, nearest = min(cands) if cands else (math.inf, "", None)
                if d <= SNAP_RADIUS_M:
                    chosen = [e for e in with_twins([nearest]) if _heading_ok(e, nodes, hint)]
                    status, method, distance = "snapped", "named road nearest to source point", d
            if not chosen and primary_keys and cross_keys:
                for ck in cross_keys:
                    shared = junction(primary_keys[0], ck)
                    if shared:
                        chosen = [
                            e for e in by_name[primary_keys[0]]
                            if (e.from_node in shared or e.to_node in shared) and _heading_ok(e, nodes, hint)
                        ]
                        status, method = "snapped", f"junction of {primary_keys[0]} and {ck}"
                        if point is not None:
                            distance = min(geo.dist(point, nodes[n]) for n in shared)
                        break
            if not chosen and point is not None:
                d, _, nearest = min((geo.dist_to_line(point, e.coords), e.id, e) for e in network.edges)
                if d <= SNAP_RADIUS_M:
                    # The stated direction belongs to the unmatched named road, so it is not applied here.
                    chosen = with_twins([nearest])
                    status, method, distance = "low_confidence", "nearest edge of any road to source point", d
                    note = "road name " + (f"{primaries} not matched" if primaries else "not given")
            if not chosen and not note:
                note = "no named road near the point and no locatable cross-street junction"

        if src["type"] in CLOSURE_TYPES:
            engine_type, factor = src["type"], None
        elif src["type"] in SOFT_CLOSURE_TYPES:
            engine_type, factor = "capacity_changed", SOFT_CLOSURE_CAPACITY_FACTOR
        elif is_contraflow:
            engine_type, factor = "contraflow_started", None
        else:
            engine_type, factor = src["type"], None
        if not chosen:
            status = "unresolved"
        snap = (
            f"{status.replace('_', ' ')}: {method}" + (f", {distance:.0f} m" if distance is not None else "")
            + f", {len(chosen)} edges" if chosen else "unresolved, timeline only"
        )
        events.append(TrafficEvent(
            id=src["event_id"],
            at=parse_utc(src["occurred_at"]),
            type=engine_type,
            label=f"{src['description']} [{snap}]",
            evidence_class=src["evidence_class"],
            time_precision=src["time_precision"],
            edge_ids=tuple(e.id for e in chosen),
            source_id=src["source_id"],
            source_locator=src.get("source_locator"),
            capacity_factor=factor,
        ))
        report.append({
            "event_id": src["event_id"],
            "at": src["occurred_at"],
            "source_type": src["type"],
            "engine_type": engine_type,
            "road_name": road_text,
            "evidence_class": src["evidence_class"],
            "status": status,
            "method": method,
            "distance_m": None if distance is None else round(distance, 1),
            "direction_hint": hint,
            "edge_ids": [e.id for e in chosen],
            "edge_names": sorted({e.name for e in chosen}),
            "capacity_factor": factor,
            "note": note,
        })
    events.sort(key=lambda ev: (ev.at, ev.id))
    return tuple(events), report
