"""The evacuation advisory lifecycle, and the human approval gate in front of it.

This is the safety-critical module of the package. Read the gate before changing
anything here.

**V1 ships no channel that reaches residents.** The only delivery channel in this
module, :class:`ReviewQueueChannel`, appends to a planner's review-queue file and
declares ``reaches_residents = False``. Nothing in CrisisTwin sends a message to
a member of the public, and nothing here may be adapted into something that does
as an incidental coding step. Adding a channel that reaches residents would
require an explicitly authorised workflow, the agreement of the authority that
owns the alert, and a review of this module by a human - not a new class that
sets ``reaches_residents = True``.

The lifecycle this module supports:

1. :func:`build_advisory` assembles an :class:`EvacuationAdvisory` from an area,
   an :class:`ExposureAssessment`, the evidence it rests on, and the model run
   ids that produced it. The result is always ``status="draft"``. The builder has
   no parameter that can produce any other status, because a model must not be
   able to advance an advisory towards delivery.
2. A named human moves the draft on, by calling ``advisory.approve(name)`` or
   ``advisory.reject(reason)`` from a planner workflow.
3. A channel refuses anything that is not approved by a named human, by raising
   :class:`~crisistwin_agent.ports.ApprovalRequiredError` before it writes
   anything at all.

Every rendered surface folds in ``EvacuationAdvisory.disclosure()``: CrisisTwin
output is a planning experiment from a simulation model, it is not operational
evacuation guidance, and it carries no authority approval. Text produced here is
written for a planner reviewing a model run, never as instructions to residents.

Where a number is unknown the text says it is unknown. An unavailable population
estimate is never rendered as ``0``.

The drafting agent may pass its own headline and rationale. They are kept as
model narration, under their own heading and clearly labelled: the advisory's
own headline and every figure in its body are assembled from the assessment, so
an invented number in the agent's wording cannot become a reported result.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Sequence
from datetime import datetime
from pathlib import Path
from typing import Any, Final
from uuid import uuid4

from .domain import (
    AreaOfInterest,
    EvacuationAdvisory,
    Evidence,
    EvidenceKind,
    ExposedAsset,
    ExposureAssessment,
    SpreadProjection,
    utc_now,
)
from .ports import ApprovalRequiredError, PortUnavailableError

DEFAULT_CHANNEL_ID: Final[str] = "planner-review-queue"
DEFAULT_REVIEW_QUEUE_PATH: Final[Path] = Path(__file__).resolve().parent.parent / "review_queue.jsonl"

_TAG_BY_KIND: Final[dict[EvidenceKind, str]] = {
    "observation": "[observed]",
    "recorded-fixture": "[recorded fixture]",
    "simulation": "[simulated]",
    "assumption": "[planner assumption]",
}
_TAG_SIM_OVER_FIXTURE: Final[str] = "[simulated over recorded fixture]"
_TAG_RECORD: Final[str] = "[record]"
_TAG_LIMITATION: Final[str] = "[model limitation]"
_TAG_NARRATION: Final[str] = "[agent narration]"

_BODY_BANNER: Final[str] = (
    "PLANNER REVIEW TEXT - NOT OPERATIONAL GUIDANCE, NOT ISSUED TO RESIDENTS, NO AUTHORITY APPROVAL"
)

_STANDING_ADVISORY_LIMITATIONS: Final[tuple[str, ...]] = (
    "An advisory from CrisisTwin describes a simulation run. It is not operational evacuation guidance, it "
    "carries no authority approval, and CrisisTwin issues nothing to residents.",
    "The only delivery channel in V1 writes to a planner review queue. No channel in this system reaches "
    "residents, so nothing here has been or can be sent to the public.",
    "Nothing in this advisory was observed in the field. The exposure times are simulated, and the assets, "
    "populations, and capacities are synthetic fixture values.",
)


def _status_banner(advisory: EvacuationAdvisory) -> str:
    """A banner that states the advisory's real status, so a rendered page never overstates or understates it."""
    if advisory.status == "approved" and advisory.approved_by:
        return (
            f"APPROVED FOR THE PLANNER REVIEW QUEUE by {advisory.approved_by} - planners only, not issued to "
            "residents, and carrying no authority approval"
        )
    if advisory.status == "rejected":
        return "REJECTED BY A HUMAN REVIEWER - not for use; draft a new advisory"
    if advisory.status == "pending_approval":
        return "AWAITING HUMAN APPROVAL - NOT APPROVED, NOT ISSUED, NOT SENT TO ANYONE"
    return "DRAFT - PLANNER REVIEW ONLY - NOT APPROVED, NOT ISSUED, NOT SENT TO ANYONE"


def _format_elapsed(minutes: int | None) -> str:
    if minutes is None:
        return "time unknown"
    if minutes < 60:
        return f"T+{minutes} min"
    return f"T+{minutes} min ({minutes // 60} h {minutes % 60:02d} min)"


def _format_timestamp(moment: datetime | None) -> str:
    return "unknown" if moment is None else moment.isoformat().replace("+00:00", "Z")


def _plural(count: int, singular: str, plural: str | None = None) -> str:
    return singular if count == 1 else (plural or f"{singular}s")


def _dedupe_evidence(items: Iterable[Evidence]) -> tuple[Evidence, ...]:
    return tuple(dict.fromkeys(items))


def _dedupe_strings(items: Iterable[str]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(item for item in items if item))


def _population_sentence(assessment: ExposureAssessment) -> str:
    """State the population estimate, or state plainly that there is none. Never substitute a figure."""
    population = assessment.population_at_risk
    with_estimate = sum(1 for asset in assessment.assets if asset.population_estimate is not None)
    without_estimate = len(assessment.assets) - with_estimate
    if population is None:
        return (
            "Population estimate: UNAVAILABLE. No exposed asset in the registry carries a population estimate, so "
            "this advisory states no figure. Unavailable is not zero, and no number should be read in here."
        )
    sentence = (
        f"Population estimate: {population:,}, summed from the synthetic estimates of the {with_estimate} exposed "
        f"{_plural(with_estimate, 'asset')} that carry one. These are invented fixture numbers, not a count of "
        "real people."
    )
    if without_estimate:
        sentence += (
            f" {without_estimate} further exposed {_plural(without_estimate, 'asset')} carry no population "
            "estimate and are not in that sum, so the true modelled total is higher by an unknown amount."
        )
    return sentence


def _headline(area: AreaOfInterest, assessment: ExposureAssessment) -> str:
    count = len(assessment.assets)
    if count == 0:
        return (
            f"DRAFT - simulated run reached no modelled asset in {area.name} within its horizon "
            "(not a finding that the area is safe)"
        )
    earliest = assessment.earliest_exposure_minutes()
    when = f"first at {_format_elapsed(earliest)}" if earliest is not None else "first exposure time unknown"
    return f"DRAFT - simulated exposure in {area.name}: {count} modelled {_plural(count, 'asset')}, {when}"


def _asset_line(asset: ExposedAsset) -> str:
    when = _format_elapsed(asset.first_exposure_minutes)
    if asset.population_estimate is None:
        population = "no population estimate"
    else:
        population = f"population estimate {asset.population_estimate:,}"
    return f"- {when}: {asset.name} ({asset.kind}, id {asset.asset_id}) - {population}"


def _body(
    area: AreaOfInterest,
    assessment: ExposureAssessment,
    model_run_ids: tuple[str, ...],
    limitations: tuple[str, ...],
    agent_headline: str | None = None,
    agent_rationale: str | None = None,
) -> str:
    """The advisory body. ``EvacuationAdvisory.disclosure()`` is folded in at the top."""
    earliest = assessment.earliest_exposure_minutes()
    centre = area.center
    lines: list[str] = [
        _BODY_BANNER,
        "Status when drafted: DRAFT, awaiting review by a named human planner.",
        "",
        EvacuationAdvisory.disclosure(),
        "",
        "WHAT THE MODEL SHOWS",
        f"Watch area: {area.name}, centred on {centre.latitude:.4f}, {centre.longitude:.4f} (WGS84) with a "
        f"{area.radius_meters / 1000:.1f} km radius. The area is a planner-chosen scenario input.",
        f"Projection run: {', '.join(model_run_ids)} (exposure derived from run {assessment.projection_run_id}).",
    ]

    if assessment.assets:
        lines.append(
            f"The projected footprint covers {len(assessment.assets)} modelled "
            f"{_plural(len(assessment.assets), 'asset')} within the projection's horizon."
        )
        if earliest is None:
            lines.append(
                "Earliest modelled exposure: UNKNOWN. Exposed assets are listed without a time, so no earliest "
                "time can be stated."
            )
        else:
            lines.append(
                f"Earliest modelled exposure: {_format_elapsed(earliest)} after modelled ignition, on the "
                "simulation clock rather than the wall clock."
            )
        lines.append(_population_sentence(assessment))
        lines.append("")
        lines.append("MODELLED ASSETS IN THE FOOTPRINT, EARLIEST FIRST")
        lines.extend(_asset_line(asset) for asset in assessment.assets)
    else:
        lines.append(
            "The projected footprint covered no asset in the modelled registry within the projection's horizon. "
            "That is not a finding that the area is safe: the registry holds only the synthetic assets listed in "
            "it, and the model sees only what the simulated perimeter covers."
        )
        lines.append(_population_sentence(assessment))

    if agent_headline or agent_rationale:
        lines.extend(
            [
                "",
                "AGENT NARRATION (the drafting agent's own words, not a computed result)",
                "The lines below were written by the language model that drafted this advisory. They are its "
                "reading of the run. No figure in them has been checked, and the computed values are the ones "
                "above, which come from the exposure assessment.",
            ]
        )
        if agent_headline:
            lines.append(f"- headline: {agent_headline}")
        if agent_rationale:
            lines.append(f"- rationale: {agent_rationale}")

    lines.extend(
        [
            "",
            "WHAT THIS DOES NOT TELL YOU",
            *(f"- {text}" for text in limitations),
            "",
            "WHAT HAPPENS NEXT",
            "A named human planner reviews this draft and approves or rejects it. Until someone approves it, "
            "every delivery channel refuses it. Approval inside CrisisTwin records a planner's review of a "
            "simulation; it is not authority approval and it issues nothing to residents.",
        ]
    )
    return "\n".join(lines)


def build_advisory(
    *,
    area: AreaOfInterest,
    assessment: ExposureAssessment,
    projection: SpreadProjection | None = None,
    basis: Sequence[Evidence] = (),
    model_run_ids: Sequence[str] = (),
    headline: str | None = None,
    rationale: str | None = None,
    extra_limitations: Sequence[str] = (),
) -> EvacuationAdvisory:
    """Assemble a ``draft`` advisory from an exposure assessment.

    The advisory's headline and body are built from the assessment's own values:
    the earliest exposure time, the named assets with their exposure times, and
    the population estimate when one exists. An unavailable population is
    reported as unavailable, never as zero.

    ``basis`` is the evidence the advisory rests on - the detection source, the
    weather assumption, the projection. The assessment's evidence is always
    added, and ``projection`` contributes its own evidence and that of its
    weather assumption, so the advisory can never cite nothing.
    ``model_run_ids`` records the runs behind it; the projection run id is added
    when missing.

    ``headline`` and ``rationale`` are the drafting agent's wording. They are
    recorded in the body under "AGENT NARRATION", labelled as the model's words,
    and they never replace a computed figure or the computed headline.

    The returned advisory is always ``status="draft"``. There is deliberately no
    argument that can produce any other status: approval is a human act, taken
    through :meth:`EvacuationAdvisory.approve`.
    """
    contributing: list[Evidence] = [*basis]
    if projection is not None:
        contributing.extend([projection.evidence, projection.weather.evidence])
    contributing.append(assessment.evidence)
    evidence_chain = _dedupe_evidence(contributing)
    if not evidence_chain:
        raise ValueError("an advisory must cite the evidence it rests on; none was supplied")

    run_ids = _dedupe_strings(
        [*model_run_ids, assessment.projection_run_id, projection.run_id if projection is not None else ""]
    )
    projection_limitations = (
        tuple(f"Inherited from projection {projection.run_id}: {text}" for text in projection.limitations)
        if projection is not None
        else ()
    )
    limitations = _dedupe_strings(
        [
            *assessment.limitations,
            *projection_limitations,
            *extra_limitations,
            *_STANDING_ADVISORY_LIMITATIONS,
        ]
    )
    agent_headline = headline.strip() if headline and headline.strip() else None
    agent_rationale = rationale.strip() if rationale and rationale.strip() else None

    return EvacuationAdvisory(
        area=area,
        headline=_headline(area, assessment),
        body=_body(area, assessment, run_ids, limitations, agent_headline, agent_rationale),
        affected_assets=assessment.assets,
        basis=evidence_chain,
        model_run_ids=run_ids,
        limitations=limitations,
    )


def render_advisory_text(advisory: EvacuationAdvisory) -> str:
    """The planner-facing review text, with every line tagged by what it rests on.

    Tags are the four evidence kinds - ``[observed]``, ``[simulated]``,
    ``[recorded fixture]``, ``[planner assumption]`` - plus two that are not
    evidence about the fire and say so: ``[record]`` for facts about this
    advisory record, and ``[model limitation]`` for what the method cannot see.
    A combined tag means a claim rests on more than one kind.
    """
    area = advisory.area
    centre = area.center
    assets = advisory.affected_assets
    earliest = min(
        (asset.first_exposure_minutes for asset in assets if asset.first_exposure_minutes is not None),
        default=None,
    )
    known_populations = [asset.population_estimate for asset in assets if asset.population_estimate is not None]

    lines: list[str] = [
        _status_banner(advisory),
        "=" * 100,
        f"{_TAG_RECORD} advisory_id: {advisory.advisory_id}",
        f"{_TAG_RECORD} status: {advisory.status.upper()}; approved_by: {advisory.approved_by or 'nobody'}; "
        f"approved_at: {_format_timestamp(advisory.approved_at)}",
        f"{_TAG_RECORD} created_at: {_format_timestamp(advisory.created_at)}",
        f"{_TAG_RECORD} model runs: {', '.join(advisory.model_run_ids) or 'none recorded'}",
        f"{_TAG_RECORD} deliverable: {'yes' if advisory.is_deliverable else 'no - no named human has approved it'}",
    ]
    if advisory.rejection_reason:
        lines.append(f"{_TAG_RECORD} rejected because: {advisory.rejection_reason}")

    lines.extend(
        [
            "",
            "LEGEND  [observed] field or satellite observation | [simulated] model output | [recorded fixture] "
            "stored demo data, not live | [planner assumption] a scenario input someone chose | [record] a fact "
            "about this advisory record | [model limitation] what the method cannot see | [agent narration] "
            "wording written by the language model, with nothing computed in it",
            "",
            "HEADLINE",
            f"{_TAG_SIM_OVER_FIXTURE} {advisory.headline}",
            f"{_TAG_NARRATION} If the drafting agent supplied its own headline or rationale, they sit in the "
            "advisory body under AGENT NARRATION. They are the model's wording, and no figure in them is a "
            "computed result.",
            "",
            "SCENARIO",
            f"{_TAG_BY_KIND['assumption']} Watch area {area.name}: centre {centre.latitude:.4f}, "
            f"{centre.longitude:.4f} (WGS84), radius {area.radius_meters / 1000:.1f} km.",
            "",
            "EXPOSURE",
        ]
    )

    if earliest is None and assets:
        lines.append(
            f"{_TAG_BY_KIND['simulation']} Earliest modelled exposure: UNKNOWN - no listed asset carries a time."
        )
    elif earliest is None:
        lines.append(
            f"{_TAG_BY_KIND['simulation']} No modelled asset was reached within the projection's horizon. This is "
            "not a finding that the area is safe; an asset the model never reached is simply absent from it."
        )
    else:
        lines.append(
            f"{_TAG_BY_KIND['simulation']} Earliest modelled exposure: {_format_elapsed(earliest)} after modelled "
            "ignition, on the simulation clock."
        )

    if known_populations:
        lines.append(
            f"{_TAG_SIM_OVER_FIXTURE} Population estimate across exposed assets: {sum(known_populations):,}, "
            f"summed from {len(known_populations)} synthetic fixture {_plural(len(known_populations), 'value')}. "
            "Invented numbers, not a count of real people."
        )
        missing = len(assets) - len(known_populations)
        if missing:
            lines.append(
                f"{_TAG_BY_KIND['recorded-fixture']} {missing} exposed {_plural(missing, 'asset')} carry no "
                "population estimate and are outside that sum, so the modelled total is higher by an unknown "
                "amount."
            )
    else:
        lines.append(
            f"{_TAG_BY_KIND['recorded-fixture']} Population estimate: UNAVAILABLE - no exposed asset carries "
            "one. Unavailable is not zero."
        )

    if assets:
        lines.extend(["", "MODELLED ASSETS IN THE FOOTPRINT, EARLIEST FIRST"])
        for asset in assets:
            when = _format_elapsed(asset.first_exposure_minutes)
            if asset.population_estimate is None:
                population = "no population estimate"
            else:
                population = f"population estimate {asset.population_estimate:,}"
            lines.append(
                f"{_TAG_SIM_OVER_FIXTURE} {when}: {asset.name} ({asset.kind}, id {asset.asset_id}) - {population}"
            )

    lines.extend(["", "WHAT THIS RESTS ON"])
    for evidence in advisory.basis:
        tag = _TAG_BY_KIND[evidence.kind]
        lines.append(
            f"{tag} {evidence.source_name} (id {evidence.source_id}, retrieved "
            f"{_format_timestamp(evidence.retrieved_at)}) - {evidence.label()}"
        )
        if evidence.note:
            lines.append(f"       note: {evidence.note}")
        if evidence.source_url:
            lines.append(f"       source: {evidence.source_url}")

    lines.extend(["", "WHAT THIS DOES NOT TELL YOU"])
    lines.extend(f"{_TAG_LIMITATION} {text}" for text in advisory.limitations)

    lines.extend(
        [
            "",
            "DELIVERY",
            f"{_TAG_RECORD} The only channel in V1 writes to the planner review queue and reaches planners only. "
            "No channel in CrisisTwin reaches residents.",
            f"{_TAG_RECORD} A delivery attempt on an unapproved advisory is refused with ApprovalRequiredError "
            "and writes nothing.",
            "",
            "DISCLOSURE",
            f"{_TAG_RECORD} {EvacuationAdvisory.disclosure()}",
            "=" * 100,
            _status_banner(advisory),
        ]
    )
    return "\n".join(lines)


def advisory_as_record(advisory: EvacuationAdvisory) -> dict[str, Any]:
    """The advisory as a JSON-serialisable record, carrying its provenance and caveats with it."""
    return {
        "advisory_id": advisory.advisory_id,
        "status": advisory.status,
        "created_at": _format_timestamp(advisory.created_at),
        "approved_by": advisory.approved_by,
        "approved_at": _format_timestamp(advisory.approved_at) if advisory.approved_at else None,
        "rejection_reason": advisory.rejection_reason,
        "area": {
            "name": advisory.area.name,
            "center": {
                "latitude": advisory.area.center.latitude,
                "longitude": advisory.area.center.longitude,
            },
            "radius_meters": advisory.area.radius_meters,
        },
        "headline": advisory.headline,
        "body": advisory.body,
        "affected_assets": [
            {
                "asset_id": asset.asset_id,
                "kind": asset.kind,
                "name": asset.name,
                "first_exposure_minutes": asset.first_exposure_minutes,
                "population_estimate": asset.population_estimate,
            }
            for asset in advisory.affected_assets
        ],
        "population_at_risk": (
            sum(a.population_estimate for a in advisory.affected_assets if a.population_estimate is not None)
            if any(a.population_estimate is not None for a in advisory.affected_assets)
            else None
        ),
        "basis": [
            {
                "kind": evidence.kind,
                "label": evidence.label(),
                "source_id": evidence.source_id,
                "source_name": evidence.source_name,
                "retrieved_at": _format_timestamp(evidence.retrieved_at),
                "source_url": evidence.source_url,
                "note": evidence.note,
            }
            for evidence in advisory.basis
        ],
        "model_run_ids": list(advisory.model_run_ids),
        "limitations": list(advisory.limitations),
        "disclosure": EvacuationAdvisory.disclosure(),
    }


class ReviewQueueChannel:
    """Delivers an approved advisory to a planner's review queue file. PLANNERS ONLY.

    This channel reaches no resident and no public alerting system. It appends
    one JSON object per line to a local file that a planner reads, and
    ``reaches_residents`` is a class attribute fixed at ``False`` with no
    constructor argument that can flip it.

    The gate: :meth:`deliver` raises
    :class:`~crisistwin_agent.ports.ApprovalRequiredError` unless
    ``advisory.is_deliverable`` - that is, unless a named human has approved it.
    The check runs before the file is opened, so a refused advisory leaves no
    trace in the queue and no receipt is returned.
    """

    reaches_residents: bool = False

    def __init__(self, queue_path: Path | None = None, channel_id: str = DEFAULT_CHANNEL_ID) -> None:
        self.channel_id = channel_id
        self.queue_path = Path(queue_path) if queue_path is not None else DEFAULT_REVIEW_QUEUE_PATH

    def deliver(self, advisory: EvacuationAdvisory) -> str:
        """Append an approved advisory to the review queue and return a receipt id.

        Raises ``ApprovalRequiredError`` when no named human has approved the
        advisory, and ``PortUnavailableError`` when the queue file cannot be
        written. Neither failure is swallowed and neither returns a receipt.
        """
        if not advisory.is_deliverable:
            reason = advisory.status if advisory.approved_by else f"{advisory.status} with no named approver"
            raise ApprovalRequiredError(advisory.advisory_id, reason)

        receipt_id = f"rq_{uuid4().hex[:12]}"
        record = advisory_as_record(advisory)
        record.update(
            {
                "receipt_id": receipt_id,
                "channel_id": self.channel_id,
                "reaches_residents": self.reaches_residents,
                "destination": "planner review queue - planners only, no resident channel exists in V1",
                "delivered_at": _format_timestamp(utc_now()),
                "review_text": render_advisory_text(advisory),
            }
        )
        line = json.dumps(record, ensure_ascii=False, sort_keys=True)
        try:
            self.queue_path.parent.mkdir(parents=True, exist_ok=True)
            with self.queue_path.open("a", encoding="utf-8") as queue_file:
                queue_file.write(f"{line}\n")
        except OSError as exc:
            raise PortUnavailableError(f"review queue {self.queue_path}", str(exc)) from exc
        return receipt_id
