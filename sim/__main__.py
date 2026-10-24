"""CrisisTwin historical replay simulator CLI.

Subcommands write JSON/GeoJSON for viewing or app integration:
  frame      observed perimeter and damage at one time
  timeline   compact observed replay for animation
  hindcast   simulate fire spread from an observed perimeter and score it against later ones
  calibrate  pick fire parameters on a training window, report held-out skill
  bundle     run fire + traffic and write a replay bundle for the web app (docs/replay-bundle.md)
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import timedelta
from pathlib import Path

from tools.build_camp_history import SourceError

from sim.bundle import build_bundle
from sim.fire import FireParams
from sim.fixtures import camp_fixture_scenario
from sim.hindcast import calibrate, default_candidates, run_hindcast
from sim.history import load_history, parse_utc
from sim.network import load_road_network
from sim.replay import observed_frame, timeline
from sim.scenario import hybrid_scenario
from sim.traffic import TrafficParams


def _write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # allow_nan=False: unreached cells (math.inf) must never leak into JSON output.
    path.write_text(json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n")


def _fire_params(args: argparse.Namespace) -> FireParams:
    return FireParams(
        base_spread_m_per_min=args.spread,
        wind_from_deg=args.wind_from,
        wind_speed_m_s=args.wind_speed,
    )


def main() -> None:
    parser = argparse.ArgumentParser(prog="python3 -m sim", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--package", type=Path, required=True, help="verified incident package directory")
    sub = parser.add_subparsers(dest="command", required=True)

    frame = sub.add_parser("frame", help="observed GeoJSON frame at one time")
    frame.add_argument("--at", required=True, help="ISO 8601 time with Z or UTC offset")
    frame.add_argument("--output", type=Path, required=True)

    line = sub.add_parser("timeline", help="observed replay timeline for animation")
    line.add_argument("--start", help="ISO 8601 (default: first snapshot)")
    line.add_argument("--end", help="ISO 8601 (default: last snapshot)")
    line.add_argument("--step-minutes", type=float, default=60)
    line.add_argument("--output", type=Path, required=True)

    hind = sub.add_parser("hindcast", help="simulate spread from an observed perimeter and score it")
    hind.add_argument("--start-index", type=int, default=0, help="perimeter snapshot used as ignition")
    hind.add_argument("--hours", type=float, default=48, help="simulation horizon")
    hind.add_argument("--cell-m", type=float, default=200)
    hind.add_argument("--spread", type=float, required=True, help="no-wind spread rate, m/min")
    hind.add_argument("--wind-from", type=float, required=True, help="degrees clockwise from north")
    hind.add_argument("--wind-speed", type=float, required=True, help="m/s")
    hind.add_argument("--geometry", action="store_true", help="include simulated burned-area geometry")
    hind.add_argument("--output", type=Path, required=True)

    cal = sub.add_parser("calibrate", help="grid-search fire parameters on a training window")
    cal.add_argument("--start-index", type=int, default=0)
    cal.add_argument("--train-hours", type=float, default=24)
    cal.add_argument("--test-hours", type=float, default=48)
    cal.add_argument("--cell-m", type=float, default=200)
    cal.add_argument("--output", type=Path, required=True)

    bun = sub.add_parser("bundle", help="fire + traffic replay bundle for the web app")
    bun.add_argument("--roads-package", type=Path,
                     help="verified road package (camp-2018-evacuation); omit for the synthetic fixture network")
    bun.add_argument("--start", help="ISO 8601 (default: scenario start)")
    bun.add_argument("--end", help="ISO 8601 (default: scenario end)")
    bun.add_argument("--seed", type=int, default=TrafficParams.seed)
    bun.add_argument("--record-every-s", type=int, default=TrafficParams.record_every_s)
    bun.add_argument("--no-simulated-fire", action="store_true", help="omit the simulated morning fire front")
    bun.add_argument("--output", type=Path, required=True)

    args = parser.parse_args()
    try:
        history = load_history(args.package)
        if args.command == "frame":
            result = observed_frame(history, parse_utc(args.at))
            meta = result["replay"]
            summary = f"{meta['coverage']}, snapshot {meta['snapshot_at']}"
        elif args.command == "timeline":
            result = timeline(
                history,
                start=parse_utc(args.start) if args.start else None,
                end=parse_utc(args.end) if args.end else None,
                step=timedelta(minutes=args.step_minutes),
            )
            summary = f"{len(result['frames'])} frames, {len(result['perimeters'])} perimeters"
        elif args.command == "hindcast":
            result = run_hindcast(history, _fire_params(args), start_index=args.start_index,
                                  horizon_hours=args.hours, cell_m=args.cell_m, include_geometry=args.geometry)
            summary = json.dumps(result["summary"])
        elif args.command == "bundle":
            if args.roads_package:
                network, exits, provenance = load_road_network(args.roads_package)
                scenario = hybrid_scenario(network, exits, provenance["assumptions"])
                start = parse_utc(args.start or "2018-11-08T14:00:00Z")
                end = parse_utc(args.end or "2018-11-09T08:00:00Z")
            else:
                scenario = camp_fixture_scenario()
                start = parse_utc(args.start) if args.start else scenario["clock_start"]
                end = parse_utc(args.end) if args.end else scenario["clock_end"]
            params = TrafficParams(seed=args.seed, record_every_s=args.record_every_s)
            result = build_bundle(history, scenario, params, start=start, end=end,
                                  command=" ".join(["python3 -m sim", *sys.argv[1:]]),
                                  simulate_fire=not args.no_simulated_fire)
            summary = json.dumps(result["traffic"]["summary"])
        else:
            result = calibrate(history, default_candidates(), start_index=args.start_index,
                               train_hours=args.train_hours, test_hours=args.test_hours, cell_m=args.cell_m)
            summary = f"best {json.dumps(result['best_params'])}"
        _write(args.output, result)
    except (OSError, SourceError, ValueError, json.JSONDecodeError) as exc:
        parser.exit(1, f"error: {exc}\n")
    print(f"{args.output}: {summary}")


if __name__ == "__main__":
    main()
