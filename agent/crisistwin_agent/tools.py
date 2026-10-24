"""The tool surface the model drives, and the session state behind it.

Every tool is a thin, validating wrapper over a port. The pattern in each one is
the same and is deliberate:

1. Validate the model's arguments before anything executes. Arguments arrive
   from a language model and are treated as untrusted input, per ``AGENTS.md``:
   "Validate any LLM-produced scenario parameters before execution."
2. Call the port, which does the actual computation.
3. Return a JSON payload that carries the numbers *and* the evidence kind that
   says what sort of claim they support.

A tool never computes a domain quantity itself, and never answers with a
plausible substitute when a port fails - a failure comes back as an error
payload the model has to account for.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from anthropic import beta_tool

from .advisory import ReviewQueueChannel, build_advisory, render_advisory_text
from .config import (
    MAX_LOOKBACK_HOURS,
    MAX_WIND_SPEED_MPH,
    VALID_HORIZON_MINUTES,
    VALID_MOISTURE_PRESETS,
)
from .detection.clustering import cluster_detections
from .domain import (
    AreaOfInterest,
    DetectionCluster,
    EvacuationAdvisory,
    Evidence,
    ExposureAssessment,
    SpreadProjection,
    WeatherAssumption,
    utc_now,
)
from .ports import (
    AgentError,
    DetectionSource,
    ExposureModel,
    FireSpreadModel,
    NonBurnableIgnitionError,
    OutOfCoverageError,
    PortUnavailableError,
)


def _ok(payload: dict[str, Any]) -> str:
    return json.dumps({"ok": True, **payload}, default=str)


def _err(kind: str, message: str, **extra: Any) -> str:
    """An error the model must report rather than route around."""
    return json.dumps({"ok": False, "error": {"kind": kind, "message": message, **extra}}, default=str)


@dataclass(slots=True)
class WatchSession:
    """Everything one watch run knows.

    Tool functions are stateless; this object holds the ports they call and the
    artefacts they produce, so the model can refer to a cluster or a model run
    by id across turns instead of passing whole objects through the prompt.
    """

    areas: dict[str, AreaOfInterest]
    detection_source: DetectionSource
    spread_model: FireSpreadModel
    exposure_model: ExposureModel
    review_channel: ReviewQueueChannel

    clusters: dict[str, DetectionCluster] = field(default_factory=dict)
    projections: dict[str, SpreadProjection] = field(default_factory=dict)
    assessments: dict[str, ExposureAssessment] = field(default_factory=dict)
    advisories: dict[str, EvacuationAdvisory] = field(default_factory=dict)
    cluster_areas: dict[str, str] = field(default_factory=dict)
    """cluster_id -> watch area name."""

    projection_areas: dict[str, str] = field(default_factory=dict)
    """projection run_id -> watch area name, so an advisory names the area it covers."""

    def area(self, name: str) -> AreaOfInterest:
        try:
            return self.areas[name]
        except KeyError:
            known = ", ".join(sorted(self.areas)) or "none configured"
            raise AgentError(f"unknown watch area {name!r}; configured areas: {known}") from None


def build_tools(session: WatchSession) -> list[Any]:
    """Build the tool set bound to one session.

    The tools are closures over ``session`` so the SDK can generate their
    schemas from ordinary typed signatures while still reaching session state.
    """

    @beta_tool
    def list_watch_areas() -> str:
        """List the geographic areas this agent is configured to watch.

        Call this first when you do not already know which area names are valid.
        """
        return _ok(
            {
                "areas": [
                    {
                        "name": area.name,
                        "center": {"latitude": area.center.latitude, "longitude": area.center.longitude},
                        "radius_meters": area.radius_meters,
                    }
                    for area in session.areas.values()
                ],
                "coordinate_reference": "WGS84 decimal degrees",
            }
        )

    @beta_tool
    def scan_for_fire_detections(area_name: str, lookback_hours: int = 12) -> str:
        """Scan a watch area for satellite fire detections and group them into candidate fires.

        A detection is an observation of heat by a satellite instrument. It is not a fire
        perimeter, not a confirmed fire, and not a road closure. An empty result means the
        source answered and saw nothing, which is different from the source being unreachable.

        Args:
            area_name: Name of a configured watch area, from list_watch_areas.
            lookback_hours: How far back to look, in hours. Between 1 and 168.
        """
        if not 1 <= lookback_hours <= MAX_LOOKBACK_HOURS:
            return _err("invalid_argument", f"lookback_hours must be between 1 and {MAX_LOOKBACK_HOURS}")
        try:
            area = session.area(area_name)
        except AgentError as exc:
            return _err("invalid_argument", str(exc))

        since = utc_now() - timedelta(hours=lookback_hours)
        try:
            detections = session.detection_source.fetch(area, since)
        except PortUnavailableError as exc:
            return _err("source_unavailable", str(exc), source=exc.source)

        clusters = cluster_detections(detections)
        for cluster in clusters:
            session.clusters[cluster.cluster_id] = cluster
            session.cluster_areas[cluster.cluster_id] = area.name

        evidence_kinds = sorted({d.evidence.kind for d in detections})
        return _ok(
            {
                "area": area.name,
                "window_start_utc": since,
                "window_end_utc": utc_now(),
                "detection_count": len(detections),
                "evidence": evidence_kinds or ["observation"],
                "evidence_note": (
                    "RECORDED FIXTURE - replayed demo data, not live observations"
                    if "recorded-fixture" in evidence_kinds
                    else "live satellite observations of heat, not fire perimeters"
                ),
                "clusters": [
                    {
                        "cluster_id": c.cluster_id,
                        "centroid": {"latitude": c.centroid.latitude, "longitude": c.centroid.longitude},
                        "detection_count": len(c.detections),
                        "radius_meters": round(c.radius_meters, 1),
                        "earliest_detected_utc": c.earliest_detected_at,
                        "latest_detected_utc": c.latest_detected_at,
                        "highest_confidence": c.highest_confidence,
                        "total_frp_megawatts": c.total_frp_megawatts,
                        "grouping_method": c.grouping_method,
                    }
                    for c in clusters
                ],
            }
        )

    @beta_tool
    def project_fire_spread(
        cluster_id: str,
        wind_speed_mph: float,
        wind_from_degrees: float,
        moisture_preset: str,
        horizon_minutes: int = 180,
    ) -> str:
        """Project how a fire at a detection cluster could spread, using the Rothermel surface model.

        This runs the real fire model over LANDFIRE fuel and terrain around the ignition
        point, so it needs network access and only works in the contiguous United States.
        The weather you pass is an assumption, not an observation; it is recorded as such.

        Args:
            cluster_id: Cluster to treat as the ignition point, from scan_for_fire_detections.
            wind_speed_mph: Open 20-foot wind speed in miles per hour, 0 to 100.
            wind_from_degrees: Meteorological bearing the wind blows FROM, degrees clockwise from true north.
            moisture_preset: One of critical, dry, moderate, wet.
            horizon_minutes: How far ahead to project. One of 120, 180, 360.
        """
        if not 0 <= wind_speed_mph <= MAX_WIND_SPEED_MPH:
            return _err("invalid_argument", f"wind_speed_mph must be between 0 and {MAX_WIND_SPEED_MPH}")
        if moisture_preset not in VALID_MOISTURE_PRESETS:
            return _err("invalid_argument", f"moisture_preset must be one of {list(VALID_MOISTURE_PRESETS)}")
        if horizon_minutes not in VALID_HORIZON_MINUTES:
            return _err("invalid_argument", f"horizon_minutes must be one of {list(VALID_HORIZON_MINUTES)}")
        cluster = session.clusters.get(cluster_id)
        if cluster is None:
            return _err("invalid_argument", f"unknown cluster_id {cluster_id!r}; run scan_for_fire_detections first")

        weather = WeatherAssumption(
            wind_speed_mph=wind_speed_mph,
            wind_from_degrees=wind_from_degrees,
            moisture_preset=moisture_preset,
            evidence=Evidence(
                kind="assumption",
                source_id="agent-supplied-weather",
                source_name="Weather assumed for this run",
                retrieved_at=utc_now(),
                note="Supplied as a scenario assumption; not an observation of current conditions.",
            ),
        )

        try:
            projection = session.spread_model.project(cluster, weather, horizon_minutes)
        except NonBurnableIgnitionError as exc:
            return _err(
                "non_burnable_ignition",
                f"{exc} The detection sits on ground the fuel model says cannot carry fire "
                "(water, pavement, bare rock, or developed land).",
            )
        except OutOfCoverageError as exc:
            return _err("out_of_coverage", str(exc), source=exc.source)
        except PortUnavailableError as exc:
            return _err("model_unavailable", str(exc), source=exc.source)

        session.projections[projection.run_id] = projection
        session.projection_areas[projection.run_id] = session.cluster_areas.get(cluster_id, "")
        final = projection.final_frame
        return _ok(
            {
                "projection_run_id": projection.run_id,
                "model_id": projection.model_id,
                "evidence": projection.evidence.kind,
                "evidence_note": projection.evidence.label(),
                "ignition": {
                    "latitude": projection.ignition.latitude,
                    "longitude": projection.ignition.longitude,
                },
                "assumptions": {
                    "wind_speed_mph": weather.wind_speed_mph,
                    "wind_from_degrees": weather.wind_from_degrees,
                    "moisture_preset": weather.moisture_preset,
                    "note": "Planner assumption, not observed weather.",
                },
                "step_minutes": projection.step_minutes,
                "horizon_minutes": projection.horizon_minutes,
                "frame_count": len(projection.frames),
                "fuel_model_at_ignition": projection.fuel_label,
                "head_rate_meters_per_minute": projection.head_rate_meters_per_minute,
                "burned_area_square_meters_at_horizon": round(final.burned_area_square_meters, 1),
                "max_reach_meters_at_horizon": round(final.max_reach_meters, 1),
                "burnable_fraction": projection.burnable_fraction,
                "reached_edge_of_modelled_area": projection.reached_edge,
                "limitations": list(projection.limitations),
            }
        )

    @beta_tool
    def assess_exposure(projection_run_id: str) -> str:
        """Find which modelled neighborhoods, shelters and roads a projection reaches, and when.

        Results are simulated, not observed. An asset that is absent from the result was not
        reached within the horizon by this run; that is not a finding that it is safe.

        Args:
            projection_run_id: A run id returned by project_fire_spread.
        """
        projection = session.projections.get(projection_run_id)
        if projection is None:
            return _err("invalid_argument", f"unknown projection_run_id {projection_run_id!r}")

        try:
            assessment = session.exposure_model.assess(projection)
        except PortUnavailableError as exc:
            return _err("model_unavailable", str(exc), source=exc.source)

        session.assessments[assessment.projection_run_id] = assessment
        return _ok(
            {
                "projection_run_id": assessment.projection_run_id,
                "evidence": assessment.evidence.kind,
                "evidence_note": assessment.evidence.label(),
                "exposed_asset_count": len(assessment.assets),
                "earliest_exposure_minutes": assessment.earliest_exposure_minutes(),
                "population_at_risk": assessment.population_at_risk,
                "population_note": (
                    "No exposed asset carries a population estimate; the figure is unavailable, not zero."
                    if assessment.population_at_risk is None
                    else "Sum of synthetic population estimates attached to exposed assets."
                ),
                "assets": [
                    {
                        "kind": a.kind,
                        "asset_id": a.asset_id,
                        "name": a.name,
                        "first_exposure_minutes": a.first_exposure_minutes,
                        "population_estimate": a.population_estimate,
                    }
                    for a in assessment.assets
                ],
                "limitations": list(assessment.limitations),
            }
        )

    @beta_tool
    def draft_evacuation_advisory(projection_run_id: str, headline: str, rationale: str) -> str:
        """Draft an evacuation advisory for a human planner to review.

        The advisory is created as a DRAFT. You cannot approve it and you cannot deliver it;
        a named human planner does that outside this conversation. Write the rationale for a
        professional planner, not for residents.

        Args:
            projection_run_id: The run the advisory rests on.
            headline: One line naming the area and what is exposed. No more than 120 characters.
            rationale: Why this advisory is being drafted, citing the exposure the tools returned.
        """
        headline = headline.strip()
        rationale = rationale.strip()
        if not 1 <= len(headline) <= 120:
            return _err("invalid_argument", "headline must be between 1 and 120 characters")
        if len(rationale) < 20:
            return _err("invalid_argument", "rationale must explain the basis for the advisory")

        projection = session.projections.get(projection_run_id)
        if projection is None:
            return _err("invalid_argument", f"unknown projection_run_id {projection_run_id!r}")
        assessment = session.assessments.get(projection_run_id)
        if assessment is None:
            return _err(
                "precondition_failed",
                f"no exposure assessment for {projection_run_id!r}; call assess_exposure first so the "
                "advisory rests on computed exposure rather than on your own reading of the projection",
            )
        if not assessment.assets:
            # An evacuation advisory that names nothing exposed is at best noise and at
            # worst alarming for no modelled reason. Report the projection instead.
            return _err(
                "nothing_exposed",
                f"run {projection_run_id} reaches no asset in the registry within its horizon, so there "
                "is nothing to advise evacuating. Report the projection and its reach to the planner "
                "instead of drafting an advisory. This is not a finding that the area is safe - it means "
                "this run, under these inputs, never covered a registry asset.",
            )

        area_name = session.projection_areas.get(projection_run_id, "")
        area = session.areas.get(area_name)
        if area is None:
            return _err(
                "precondition_failed",
                f"cannot resolve the watch area for {projection_run_id!r}; rerun the scan and projection",
            )

        advisory = build_advisory(
            area=area,
            assessment=assessment,
            projection=projection,
            headline=headline,
            rationale=rationale,
        )
        session.advisories[advisory.advisory_id] = advisory
        return _ok(
            {
                "advisory_id": advisory.advisory_id,
                "status": advisory.status,
                "created_utc": advisory.created_at,
                "model_run_ids": list(advisory.model_run_ids),
                "basis": [{"kind": e.kind, "source": e.source_name} for e in advisory.basis],
                "limitations": list(advisory.limitations),
                "review_text": render_advisory_text(advisory),
                "next_step": (
                    "Submit for human review with submit_advisory_for_review. You cannot approve "
                    "or deliver this advisory."
                ),
            }
        )

    @beta_tool
    def submit_advisory_for_review(advisory_id: str) -> str:
        """Place a drafted advisory in the planner review queue.

        This is as far as your authority goes. The advisory stays unapproved until a named
        human planner approves it; nothing here reaches residents.

        Args:
            advisory_id: The advisory to submit, from draft_evacuation_advisory.
        """
        advisory = session.advisories.get(advisory_id)
        if advisory is None:
            return _err("invalid_argument", f"unknown advisory_id {advisory_id!r}")
        if advisory.status == "rejected":
            return _err("precondition_failed", f"advisory {advisory_id} was rejected; draft a new one")

        advisory.status = "pending_approval"
        return _ok(
            {
                "advisory_id": advisory.advisory_id,
                "status": advisory.status,
                "reaches_residents": session.review_channel.reaches_residents,
                "awaiting": "approval by a named human planner",
                "note": (
                    "Queued for human review. It has not been approved, issued, or sent, and no "
                    "channel in this system reaches residents."
                ),
                "disclosure": EvacuationAdvisory.disclosure(),
            }
        )

    return [
        list_watch_areas,
        scan_for_fire_detections,
        project_fire_spread,
        assess_exposure,
        draft_evacuation_advisory,
        submit_advisory_for_review,
    ]
