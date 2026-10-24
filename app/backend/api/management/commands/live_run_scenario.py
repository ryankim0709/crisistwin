"""Run a scenario spec's generators against the active live incident on the drill clock (docs/live-scenario-runner.md).

    python manage.py live_run_scenario --spec api/live/specs/camp-2018-live-typical.json \\
        --base http://127.0.0.1:8040 --speed 10 --start

Simulated residents, generated 911/radio/rescue calls, simulated responders, the noise profile's truth
log and the scenario's injects (plus tower-failure comms outages) fill the drill the console and phones
watch. Everything it writes is labelled simulated. Stop with Ctrl-C, ``--duration`` (wall seconds) or
when the drill clock reaches the spec's ``window.end``; a restart is idempotent.
"""

import json
import os
import time

from django.core.management.base import BaseCommand, CommandError

from api.live import scenario_runner
from api.live.common import iso


class Command(BaseCommand):
    help = "Fill the active live drill with a scenario's simulated activity, on the drill clock (all labelled simulated)."

    def add_arguments(self, parser):
        parser.add_argument("--spec", required=True, help="Batch scenario spec (JSON), docs/batch-runner.md.")
        parser.add_argument("--base", default="http://127.0.0.1:8000", help="Server origin.")
        parser.add_argument("--seed", type=int, help="Panel seed (default: the spec's first seed).")
        parser.add_argument("--noise", choices=scenario_runner.NOISE_PROFILES,
                            help="Noise profile (default: the spec's live.noise_profile, else typical).")
        parser.add_argument("--speed", type=float,
                            help="Set the drill speed (drill seconds per wall second). The runner always follows "
                                 "the drill clock; without --speed it keeps the console's speed.")
        parser.add_argument("--start", action="store_true",
                            help="(Re)start the drill clock at the spec's window.start (controller action).")
        parser.add_argument("--interval", type=float, default=2.0, help="Wall seconds between ticks.")
        parser.add_argument("--duration", type=float, default=0.0, help="Stop after this many wall seconds (0 = until "
                                                                         "window.end or Ctrl-C).")
        parser.add_argument("--invite", default=os.environ.get("LIVE_INVITE_CODE", ""), help="Responder invite code.")
        parser.add_argument("--controller-token", default=os.environ.get("LIVE_CONTROLLER_TOKEN", ""),
                            help="Controller bearer token (injects, drill clock).")
        parser.add_argument("--summary-out", help="Write the final summary JSON here.")

    def handle(self, *args, **opts):
        try:
            spec, raw = scenario_runner.load(opts["spec"])
        except (OSError, ValueError, KeyError) as exc:
            raise CommandError(f"bad spec: {exc}") from exc
        say = self.stdout.write
        try:
            runner = scenario_runner.LiveScenarioRunner(
                spec, raw, base=opts["base"], seed=opts["seed"], invite=opts["invite"],
                controller_token=opts["controller_token"] or None, noise_profile=opts["noise"], progress=say)
        except ValueError as exc:
            raise CommandError(str(exc)) from exc
        say(f"{scenario_runner.LABEL}\nincident {runner.incident_id}, seed {runner.seed}, noise {runner.noise_profile}, "
            f"window {iso(spec.start)}..{iso(spec.end)}")
        if opts["start"] or opts["speed"] is not None:
            body = ({"action": "start", "replay_start": iso(spec.start)} if opts["start"] else {"action": "set_speed"})
            if opts["speed"] is not None:
                body["speed"] = opts["speed"]
            code, resp = runner.http.controller("POST", f"incidents/{runner.incident_id}/drill", body)
            if code != 200 and not opts["start"]:  # set_speed before a start: start at window.start instead
                body = {"action": "start", "replay_start": iso(spec.start), "speed": opts["speed"]}
                code, resp = runner.http.controller("POST", f"incidents/{runner.incident_id}/drill", body)
            if code != 200:
                raise CommandError(f"drill clock: {code} {resp}")
            say(f"drill clock: {json.dumps(resp.get('drill', {}))[:200]}")
        started = time.monotonic()
        last_report = 0.0
        try:
            while True:
                state = runner.tick()
                now = time.monotonic()
                if now - last_report >= 15:
                    last_report = now
                    counts = runner.counts
                    say(f"drill {state['t']}: residents {sum(v for k, v in counts.items() if k.startswith('resident:'))}"
                        f", comms new {counts.get('comms_new', 0)}, responder calls "
                        f"{sum(v for k, v in counts.items() if k.startswith('responder:'))}, injects "
                        f"{sum(v for k, v in counts.items() if k.startswith('inject:'))}"
                        + (f" ({state['waiting']})" if state.get("waiting") else ""))
                if state["done"]:
                    say("drill clock reached window.end")
                    break
                if opts["duration"] and now - started >= opts["duration"]:
                    break
                time.sleep(opts["interval"])
        except KeyboardInterrupt:
            pass
        finally:
            runner.stop()
            summary = runner.summary()
            say(json.dumps(summary, indent=1))
            if opts["summary_out"]:
                with open(opts["summary_out"], "w", encoding="utf-8") as fh:
                    json.dump(summary, fh, indent=1)
