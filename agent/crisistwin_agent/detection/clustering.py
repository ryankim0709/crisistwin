"""Group nearby detections into plausible incidents.

Satellite feeds report pixels, not fires: one fire usually lights several
adjacent pixels, and two fires a kilometre apart look the same as one broad
front. Grouping here is a **heuristic over pixel positions** - a convenience for
the planner's map and for choosing ignition points - and never a finding about
how many distinct fires exist. The rule and threshold that produced each group
travel with it in ``DetectionCluster.grouping_method`` so a reader can judge it.

The grouping is deterministic: input is sorted by ``(detected_at, latitude,
longitude)`` and the clusters come back sorted by ``(earliest_detected_at,
centroid latitude, centroid longitude)``, so the same detections always produce
the same clusters with the same ids. Ids number the clusters within one run;
they are not stable identities across runs over different detections.
"""

from __future__ import annotations

from collections.abc import Sequence

from ..domain import DetectionCluster, FireDetection, GeoPoint

#: Two detections within this ground distance are treated as the same incident.
#: Roughly four VIIRS 375 m pixels, wide enough to bridge the gap between pixels
#: on one fire front without merging neighbouring canyons.
DEFAULT_LINK_DISTANCE_METERS = 1500.0


def cluster_detections(
    detections: Sequence[FireDetection],
    link_distance_meters: float = DEFAULT_LINK_DISTANCE_METERS,
) -> list[DetectionCluster]:
    """Single-linkage grouping of ``detections`` by great-circle ground distance.

    Two detections join the same cluster when they are within
    ``link_distance_meters`` of each other, and clusters chain transitively, so a
    line of pixels along a ridge stays one group. The result is a heuristic
    grouping, not a count of fires: a cluster may hold one fire, several, or part
    of a larger one that the satellite only partly saw.

    Comparison is pairwise (O(n^2)); a watch area holds tens to hundreds of
    pixels, well inside what that costs.
    """
    if link_distance_meters <= 0:
        raise ValueError("link_distance_meters must be positive")

    ordered = sorted(detections, key=_detection_sort_key)
    if not ordered:
        return []

    parent = list(range(len(ordered)))

    def find(node: int) -> int:
        root = node
        while parent[root] != root:
            root = parent[root]
        while parent[node] != root:  # path compression
            parent[node], node = root, parent[node]
        return root

    for i in range(len(ordered)):
        for j in range(i + 1, len(ordered)):
            if ordered[i].location.distance_meters(ordered[j].location) <= link_distance_meters:
                root_i, root_j = find(i), find(j)
                if root_i != root_j:
                    parent[max(root_i, root_j)] = min(root_i, root_j)

    groups: dict[int, list[FireDetection]] = {}
    for index, detection in enumerate(ordered):
        groups.setdefault(find(index), []).append(detection)

    method = (
        f"single-linkage grouping on great-circle ground distance; detections within "
        f"{link_distance_meters:.0f} m of any member join the same cluster"
    )

    shaped = []
    for members in groups.values():
        centroid = _centroid(members)
        radius = max(centroid.distance_meters(member.location) for member in members)
        earliest = min(member.detected_at for member in members)
        shaped.append((earliest, centroid.latitude, centroid.longitude, centroid, radius, tuple(members)))
    shaped.sort(key=lambda item: (item[0], item[1], item[2]))

    return [
        DetectionCluster(
            cluster_id=f"cluster_{number:03d}",
            detections=members,
            centroid=centroid,
            radius_meters=radius,
            grouping_method=method,
        )
        for number, (_, _, _, centroid, radius, members) in enumerate(shaped, start=1)
    ]


def _detection_sort_key(detection: FireDetection) -> tuple[object, float, float]:
    return (detection.detected_at, detection.location.latitude, detection.location.longitude)


def _centroid(members: Sequence[FireDetection]) -> GeoPoint:
    # Arithmetic mean of latitude and longitude: a planar approximation. Over a
    # watch area of a few tens of kilometres the error against a true spherical
    # centroid is well under a pixel, so it is fine at this scale. It would not
    # be for a group spanning the antimeridian or sitting near a pole, where the
    # mean of the longitudes is meaningless.
    count = len(members)
    latitude = sum(member.location.latitude for member in members) / count
    longitude = sum(member.location.longitude for member in members) / count
    return GeoPoint(latitude=latitude, longitude=longitude)
