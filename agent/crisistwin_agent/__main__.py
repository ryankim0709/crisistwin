"""Command line entry point: ``python -m crisistwin_agent``.

Wires the ports together and runs one watch cycle. Everything this module
decides - which detection source, which area, how long a horizon - is an
operator choice made here, not something the model picks for itself.

Approving an advisory is deliberately NOT a command. Approval is a human act
performed by a named planner in a reviewed workflow; this CLI can only draft and
queue. See ``advisory.py`` and ``docs/adr/0007-fire-watch-agent.md``.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

from .advisory import ReviewQueueChannel, advisory_as_record, render_advisory_text
from .config import (
    DEFAULT_HORIZON_MINUTES,
    DEFAULT_LOOKBACK_HOURS,
    ENV_DETECTION_SOURCE,
    ENV_FIXTURE_PATH,
    ENV_HORIZON_MINUTES,
    ENV_LOG_LEVEL,
    VALID_HORIZON_MINUTES,
    AgentConfig,
    MissingCredentialError,
    load_dotenv,
)
from .detection import FirmsDetectionSource, FixtureDetectionSource
from .domain import AreaOfInterest, GeoPoint
from .exposure import FixtureExposureModel
from .ports import AgentError
from .runner import run_watch, summarize_run
from .simulation import NodeFireBridge
from .tools import WatchSession

DEFAULT_AREA_NAME = "Berkeley Hills"
DEFAULT_AREA_LATITUDE = 37.88
DEFAULT_AREA_LONGITUDE = -122.24
DEFAULT_AREA_RADIUS_KM = 8.0

DEFAULT_INSTRUCTION = (
    "Scan the watch area for fire detections. If anything is burning, project how each "
    "credible cluster could spread, assess which neighborhoods, shelters and roads are "
    "exposed and when, and draft an evacuation advisory for the planner to review. If "
    "nothing is burning, say so and stop."
)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m crisistwin_agent",
        description=(
            "Run one CrisisTwin fire-watch cycle: scan for satellite fire detections, project "
            "spread with the Rothermel model, assess exposure, and draft an advisory for human "
            "review. Outputs are planning experiments, not operational guidance."
        ),
    )
    area = parser.add_argument_group("watch area")
    area.add_argument("--area-name", default=DEFAULT_AREA_NAME, help="Label for the area being watched.")
    area.add_argument("--lat", type=float, default=DEFAULT_AREA_LATITUDE, help="Centre latitude, WGS84 degrees.")
    area.add_argument("--lon", type=float, default=DEFAULT_AREA_LONGITUDE, help="Centre longitude, WGS84 degrees.")
    area.add_argument(
        "--radius-km", type=float, default=DEFAULT_AREA_RADIUS_KM, help="Watch radius in kilometres."
    )

    source = parser.add_argument_group("detection source")
    source.add_argument(
        "--source",
        choices=("firms", "fixture"),
        default=os.environ.get(ENV_DETECTION_SOURCE, "firms"),
        help="firms = live NASA FIRMS (needs FIRMS_MAP_KEY); fixture = offline synthetic demo data.",
    )
    source.add_argument(
        "--fixture-path",
        type=Path,
        default=os.environ.get(ENV_FIXTURE_PATH),
        help="Detection fixture to replay when --source fixture.",
    )
    source.add_argument(
        "--lookback-hours", type=int, default=DEFAULT_LOOKBACK_HOURS, help="How far back to scan."
    )

    model = parser.add_argument_group("model")
    model.add_argument(
        "--horizon-minutes",
        type=int,
        choices=VALID_HORIZON_MINUTES,
        default=int(os.environ.get(ENV_HORIZON_MINUTES, DEFAULT_HORIZON_MINUTES)),
        help="Projection horizon the agent is told to use.",
    )
    model.add_argument(
        "--wind-speed-mph",
        type=float,
        default=None,
        help="Open 20-foot wind speed to assume. Omit to let the agent choose and state its assumption.",
    )
    model.add_argument(
        "--wind-from-degrees",
        type=float,
        default=None,
        help="Meteorological bearing the wind blows FROM. Omit to let the agent choose.",
    )
    model.add_argument("--max-turns", type=int, default=None, help="Hard ceiling on model turns for this run.")
    model.add_argument(
        "--no-fallbacks",
        action="store_true",
        help="Disable server-side refusal fallbacks (use if your SDK or endpoint rejects them).",
    )

    out = parser.add_argument_group("output")
    out.add_argument("--instruction", default=DEFAULT_INSTRUCTION, help="What to ask the agent to do.")
    out.add_argument(
        "--draft-out",
        type=Path,
        default=None,
        help="Append drafted advisories to this JSONL file for a planner to review. Drafts only.",
    )
    out.add_argument("--json", action="store_true", help="Emit the run result as JSON instead of prose.")
    out.add_argument(
        "--log-level",
        default=os.environ.get(ENV_LOG_LEVEL, "INFO"),
        help="Python logging level for the agent process.",
    )
    return parser


def _build_session(args: argparse.Namespace) -> WatchSession:
    area = AreaOfInterest(
        name=args.area_name,
        center=GeoPoint(latitude=args.lat, longitude=args.lon),
        radius_meters=args.radius_km * 1000.0,
    )

    if args.source == "fixture":
        detection_source = (
            FixtureDetectionSource(args.fixture_path) if args.fixture_path else FixtureDetectionSource()
        )
        logging.warning(
            "Detection source is a RECORDED FIXTURE: synthetic demo data, not live observations. "
            "Nothing in this run observes a real fire."
        )
    else:
        detection_source = FirmsDetectionSource()

    return WatchSession(
        areas={area.name: area},
        detection_source=detection_source,
        spread_model=NodeFireBridge(),
        exposure_model=FixtureExposureModel(),
        review_channel=ReviewQueueChannel(),
    )


def main(argv: list[str] | None = None) -> int:
    loaded = load_dotenv()
    args = _build_parser().parse_args(argv)
    logging.basicConfig(level=args.log_level.upper(), format="%(levelname)s %(message)s", stream=sys.stderr)
    if loaded:
        # Names only. These are credentials; the values never reach a log line.
        logging.debug("Loaded from agent/.env: %s", ", ".join(sorted(loaded)))

    try:
        config = AgentConfig.from_env()
        if args.max_turns is not None:
            config = AgentConfig(
                model=config.model,
                max_tokens=config.max_tokens,
                effort=config.effort,
                max_turns=args.max_turns,
                enable_refusal_fallbacks=not args.no_fallbacks,
            )
        elif args.no_fallbacks:
            config = AgentConfig(
                model=config.model,
                max_tokens=config.max_tokens,
                effort=config.effort,
                max_turns=config.max_turns,
                enable_refusal_fallbacks=False,
            )

        session = _build_session(args)
        instruction = (
            f"{args.instruction}\n\n"
            f"Watch area: {args.area_name}. Scan the last {args.lookback_hours} hours. "
            f"Use a {args.horizon_minutes}-minute projection horizon."
        )
        if args.wind_speed_mph is not None or args.wind_from_degrees is not None:
            instruction += _wind_clause(args.wind_speed_mph, args.wind_from_degrees)
        result = run_watch(session, instruction, config)
    except MissingCredentialError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except AgentError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130

    if args.draft_out:
        _write_drafts(args.draft_out, result.advisories)

    if args.json:
        print(json.dumps(_as_json(result), indent=2, default=str))
    else:
        _print_report(result)

    if result.refusal_category is not None:
        return 1
    return 0


def _wind_clause(speed_mph: float | None, from_degrees: float | None) -> str:
    """Tell the agent which weather assumption the operator wants the run made under.

    These stay assumptions - an operator choosing them is not an observation of
    current conditions, and the advisory must keep labelling them that way.
    """
    parts = []
    if speed_mph is not None:
        parts.append(f"an open 20-foot wind of {speed_mph} mph")
    if from_degrees is not None:
        parts.append(f"a wind blowing from {from_degrees} degrees")
    return (
        f" Run the projection under {' and '.join(parts)}. These are planner assumptions supplied "
        "by the operator, not observed weather, and must be reported as assumptions."
    )


def _write_drafts(path: Path, advisories: list) -> None:
    """Append advisory drafts for a planner to review. These are not approved and not sent."""
    if not advisories:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        for advisory in advisories:
            handle.write(json.dumps(advisory_as_record(advisory), default=str) + "\n")
    logging.info("Wrote %d advisory draft(s) to %s. None are approved.", len(advisories), path)


def _as_json(result) -> dict:
    return {
        "summary": summarize_run(result),
        "completed": result.completed,
        "turns": result.turns,
        "truncated": result.truncated,
        "refusal_category": result.refusal_category,
        "tool_calls": [{"name": c.name, "arguments": c.arguments} for c in result.tool_calls],
        "final_text": result.final_text,
        "advisories": [advisory_as_record(a) for a in result.advisories],
    }


def _print_report(result) -> None:
    print(summarize_run(result))
    print()
    if result.tool_calls:
        print("Tool calls:")
        for call in result.tool_calls:
            print(f"  - {call.name}({', '.join(f'{k}={v!r}' for k, v in call.arguments.items())})")
        print()
    if result.final_text:
        print(result.final_text)
        print()
    for advisory in result.advisories:
        print("-" * 72)
        print(render_advisory_text(advisory))
        print()


if __name__ == "__main__":
    raise SystemExit(main())
