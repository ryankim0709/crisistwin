"""Add seeded noise to generated drill events, write the hidden truth log and inject the due reports (ADR 0042).

    python manage.py live_inject_noise --events residents.json --profile typical --seed 7
    python manage.py live_inject_noise --events residents.json --profile hostile --seed 7 \\
        --changes changes.json --until 2018-11-08T17:00:00Z

``--events``: a JSON list of honest generator events (sim/gen_residents.py events, responder report
calls), or an object with an ``events`` list. ``--changes``: a JSON list of truth changes
``{id, place_id, at, coord: [lon, lat], before, after, silent?, label?, destination_id?}``.
Reports whose drill upload time is at or before ``--until`` (default: the drill's current time, or all
when no drill runs) go into ``live_reports`` as ``simulated``; the whole truth map goes into
``sim_truth``. Re-running is idempotent (reports dedupe on ``client_id``), so run it again as the drill
clock advances. Only simulated events are touched; real participants' reports are never altered.
"""

import json
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from livecore.drill import INCIDENT_ID

from api.live import simtruth
from api.live.common import wall_now
from api.live.drillcache import get_index
from api.live.state import clock_from, drill_doc


class Command(BaseCommand):
    help = "Apply a gen_noise profile to generated events, store the hidden truth log, inject due reports."

    def add_arguments(self, parser):
        parser.add_argument("--events", required=True, help="JSON file of honest generator events.")
        parser.add_argument("--profile", default="typical", help="clean, typical or hostile.")
        parser.add_argument("--seed", type=int, default=0)
        parser.add_argument("--incident", default=INCIDENT_ID)
        parser.add_argument("--changes", help="JSON file of ground-truth changes (road state, fire, shelters).")
        parser.add_argument("--until", help="Inject reports uploaded at or before this drill time (ISO Z).")
        parser.add_argument("--out", help="Also write the noised events here (JSON). Contains no truth.")

    def handle(self, *args, **opts):
        gn = simtruth._gen_noise()
        if opts["profile"] not in gn.PROFILES:
            raise CommandError(f"--profile must be one of {', '.join(gn.PROFILES)}")
        raw = json.loads(Path(opts["events"]).read_text())
        events = raw["events"] if isinstance(raw, dict) else raw
        changes = ()
        if opts["changes"]:
            changes = tuple(
                gn.TruthChange(id=c["id"], place_id=c["place_id"], at=gn.parse_utc(c["at"]), coord=tuple(c["coord"]),
                               before=c.get("before"), after=c.get("after"), label=c.get("label", ""),
                               silent=bool(c.get("silent")), destination_id=c.get("destination_id"))
                for c in json.loads(Path(opts["changes"]).read_text()))
        inc = opts["incident"]
        out, truth = gn.apply_noise(events, opts["profile"], opts["seed"],
                                    gn.NoiseOptions(changes=changes, incident_id=inc))
        if opts["out"]:
            Path(opts["out"]).write_text(json.dumps(out))
        now = wall_now()
        written = simtruth.write_truth(inc, truth, now, profile=opts["profile"], seed=opts["seed"])
        clock = clock_from(drill_doc(inc), get_index(), now)
        until = gn.parse_utc(opts["until"]) if opts["until"] else clock.replay_now
        mapper = (simtruth.drill_wall_mapper(clock.replay_start, clock.started_at, clock.speed)
                  if clock.started_at is not None else None)
        counts = simtruth.inject_reports(inc, out, now, until=until, received_at_for=mapper)
        summary = gn.truth_summary(truth)
        self.stdout.write(f"profile {opts['profile']} seed {opts['seed']}: {len(events)} honest -> {len(out)} events; "
                          f"truth entries written {written} (hidden); injected {counts}")
        self.stdout.write("by kind: " + ", ".join(f"{k} {v['true']}T/{v['false']}F" for k, v in summary["by_kind"].items()))
