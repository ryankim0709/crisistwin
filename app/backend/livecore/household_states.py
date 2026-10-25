"""Per-household stand-in states from a Live board's per-zone status counts (all simulated).

The Live board simulates households as zone cohorts: it knows *how many* households of a zone are
home, waiting, on the road or safe, never *which*. To draw houses on a map the API allocates those
counts to the zone's resource-snapshot households. The allocation is a deterministic stand-in, not
an observation (docs/live-reports.md "Run state"). Pure: stdlib only, no Django or MongoDB.

Rules (``assign_zone``):

1. Scale: when the board's zone total differs from the snapshot zone's household count, the
   per-status counts are scaled to the snapshot count with largest-remainder rounding (ties by
   ``STATUSES`` order), so the assigned total always equals the snapshot zone's households. A zone
   the board reports with 0 households (or does not report) is all ``unknown``, never zero.
2. Side statuses (``needs_transport``, ``not_leaving``, ``caught``, ``unknown``) are sticky: holders
   keep the status while the count allows; surplus holders are released first-in first-out
   (needs_transport releases households with a vehicle before carless ones). Deficits are filled
   from the other households: ``needs_transport`` carless households first, ``caught`` households
   just released from needs_transport/not_leaving first, then the least advanced.
3. Chain statuses ``home -> waiting -> evacuating -> safe``: the remaining households are ranked
   most advanced first, then first-in first-out within a status (board minute entered, then a stable
   hash of ``(run_id, household_id)``), and sliced: the first ``safe`` count are safe, the next
   ``evacuating`` are on the road, and so on. When the cumulative counts only move forward, every
   household moves forward or stays (it never flips back), and exactly the board's flows change.
   A household released from a side status enters the chain at the front of its entry status
   (needs_transport/not_leaving at ``waiting``; caught/unknown at ``home``).
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Mapping, Sequence

STATUSES = ("home", "waiting", "evacuating", "safe", "needs_transport", "not_leaving", "caught", "unknown")
CHAIN = ("home", "waiting", "evacuating", "safe")
SIDE = ("needs_transport", "not_leaving", "caught", "unknown")
RANK = {status: i for i, status in enumerate(CHAIN)}
ENTRY_RANK = {"needs_transport": 1, "not_leaving": 1, "caught": 0, "unknown": 0}
"""Chain rank a household released from a side status enters at (also its rank when a side status
picks candidates)."""
SIDE_FILL_ORDER = ("caught", "not_leaving", "needs_transport", "unknown")

State = tuple[str, float]
"""``(status, since_minute)``: the board minute the household entered the status."""


def stable_key(run_id: str, household_id: str) -> bytes:
    """Deterministic per-run shuffle key: different runs order households differently."""
    return hashlib.sha256(f"{run_id}\x1f{household_id}".encode()).digest()[:8]


def scale_counts(counts: Mapping[str, int], n: int) -> dict[str, int] | None:
    """``counts`` scaled to total ``n`` (largest remainder); None when ``counts`` total 0 and ``n`` > 0."""
    full = {s: int(counts.get(s, 0)) for s in STATUSES}
    total = sum(full.values())
    if total == n:
        return full
    if total == 0:
        return None
    out = {s: c * n // total for s, c in full.items()}
    rest = n - sum(out.values())
    by_remainder = sorted(STATUSES, key=lambda s: (-(full[s] * n % total), STATUSES.index(s)))
    for s in by_remainder[:rest]:
        out[s] += 1
    return out


def assign_zone(
    households: Sequence[tuple[str, bool]],
    counts: Mapping[str, int] | None,
    previous: Mapping[str, State],
    board_minute: float,
    keys: Mapping[str, bytes],
) -> dict[str, State]:
    """New ``{household_id: (status, since_minute)}`` for one zone.

    ``households``: the snapshot zone's ``(household_id, carless)``; ``counts``: the board's
    per-status household counts for the zone (None: zone not reported); ``previous``: the same run's
    last assignment (empty for a new run); ``keys``: ``stable_key`` per household.
    """
    n = len(households)
    target = scale_counts(counts, n) if counts is not None else None
    if target is None:
        target = {s: 0 for s in STATUSES}
        target["unknown"] = n
    carless = {hid: c for hid, c in households}

    def prev(hid: str) -> State | None:
        return previous.get(hid)

    def fifo(hid: str) -> tuple[float, bytes]:
        state = prev(hid)
        return (state[1] if state else -1.0, keys[hid])

    # 1. Side statuses: keep holders up to the count, release the surplus first-in first-out.
    side: dict[str, str] = {}
    released: set[str] = set()
    for status in SIDE:
        holders = [hid for hid, _ in households if (prev(hid) or ("",))[0] == status]
        if status == "needs_transport":
            holders.sort(key=lambda h: (carless[h], fifo(h)))  # households with a vehicle go first
        else:
            holders.sort(key=fifo)
        surplus = max(0, len(holders) - target[status])
        released.update(holders[:surplus])
        for hid in holders[surplus:]:
            side[hid] = status

    def rank(hid: str) -> int:
        state = prev(hid)
        if state is None:
            return 0
        return RANK[state[0]] if state[0] in RANK else ENTRY_RANK[state[0]]

    # 2. Side deficits, filled from the households not holding a side status.
    candidates = [hid for hid, _ in households if hid not in side]
    preference = {
        "caught": lambda h: (h not in released, rank(h), fifo(h)),
        "not_leaving": lambda h: ((1, 0, 2, 3)[rank(h)], fifo(h)),
        "needs_transport": lambda h: (not carless[h], rank(h), fifo(h)),
        "unknown": lambda h: (rank(h), fifo(h)),
    }
    for status in SIDE_FILL_ORDER:
        need = target[status] - sum(1 for s in side.values() if s == status)
        if need <= 0:
            continue
        candidates.sort(key=preference[status])
        for hid in candidates[:need]:
            side[hid] = status
        candidates = candidates[need:]

    # 3. Chain: most advanced first, first-in first-out within a status, then slice by the counts.
    def chain_key(hid: str) -> tuple[int, int, float, bytes]:
        just_released = hid in released
        since, key = fifo(hid)
        return (-rank(hid), 0 if just_released else 1, since, key)

    candidates.sort(key=chain_key)
    out: dict[str, State] = {}
    pos = 0
    for status in reversed(CHAIN):
        for hid in candidates[pos:pos + target[status]]:
            out[hid] = _state(status, prev(hid), board_minute)
        pos += target[status]
    for hid, status in side.items():
        out[hid] = _state(status, prev(hid), board_minute)
    return out


def _state(status: str, previous: State | None, board_minute: float) -> State:
    if previous is not None and previous[0] == status:
        return previous
    return (status, board_minute)


def assign_all(
    zones: Mapping[str, Sequence[tuple[str, bool]]],
    counts: Mapping[str, Mapping[str, int]],
    previous: Mapping[str, State],
    board_minute: float,
    keys: Mapping[str, bytes],
) -> dict[str, State]:
    """``assign_zone`` over every snapshot zone; zones the board did not report are all ``unknown``."""
    out: dict[str, State] = {}
    for zone_id, households in zones.items():
        out.update(assign_zone(households, counts.get(zone_id), previous, board_minute, keys))
    return out


def changed(old: Mapping[str, State], new: Mapping[str, State], ids: Iterable[str] | None = None) -> list[str]:
    """Household ids whose state differs between ``old`` and ``new``."""
    return [hid for hid in (ids if ids is not None else new) if old.get(hid) != new.get(hid)]
