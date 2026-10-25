"""Seed the scenario resource snapshots (docs/scenario-snapshots.md).

    python manage.py live_seed_snapshots                       # the three live drills
    python manage.py live_seed_snapshots --incident studio-f5caaabd2a1e --assumptions /path/to.json

Idempotent and deterministic: the same drill and assumptions give the same household ids,
counts, engines and ``content_hash``; each run replaces the incident's current snapshot
(new ``snapshot_id``). Run ``live_init_db`` first so the collections have their validators.
Restart the backend (or re-activate the drill) for an already-built traffic twin to pick up
new demand.
"""

from django.core.management.base import BaseCommand, CommandError

from api.live import snapshots
from api.live.common import ApiError


class Command(BaseCommand):
    help = "Build and store the scenario resource snapshot (households, stations, engines) of live drills."

    def add_arguments(self, parser):
        parser.add_argument("--incident", action="append", dest="incidents",
                            help="Incident id (repeatable). Default: the three live drills.")
        parser.add_argument("--assumptions", default=None,
                            help=f"Assumptions JSON (default ${snapshots.ASSUMPTIONS_ENV} or "
                                 f"{snapshots.DEFAULT_ASSUMPTIONS}).")

    def handle(self, *args, **opts):
        failed = []
        for incident_id in opts["incidents"] or snapshots.DEFAULT_INCIDENTS:
            try:
                built = snapshots.build(incident_id, opts["assumptions"])
            except ApiError as exc:
                self.stderr.write(f"{incident_id}: {exc.detail}")
                failed.append(incident_id)
                continue
            doc = snapshots.store(built)
            t = doc["totals"]
            self.stdout.write(self.style.SUCCESS(
                f"{incident_id}: {doc['snapshot_id']} (content {doc['content_hash'][:12]}) "
                f"scenario_time {doc['scenario_time']:%Y-%m-%dT%H:%M:%SZ}"))
            self.stdout.write(
                f"  households {t['households']}, occupants {t['occupants']} (unknown households "
                f"{t['unknown_occupant_households']}), vehicles {t['vehicles']}, evacuating {t['evacuating_vehicles']}, "
                f"no-vehicle households {t['no_vehicle_households']} ({t['needs_transport_occupants']} people)")
            self.stdout.write(
                f"  stations {t['stations']}, engines {t['engines_total']} (available {t['engines_available']}, "
                f"committed {t['engines_committed']}, out of service {t['engines_out_of_service']})")
            self.stdout.write(f"  basis {doc['basis']}; placement {doc['placement']}")
            hh = built["households"]
            checks = {
                "households = sum of zones": t["households"] == sum(z["households"] for z in doc["zones"]) == len(hh),
                "occupants = sum over households": t["occupants"] is None
                or t["occupants"] == sum(h["occupants"]["value"] for h in hh),
                "evacuating <= vehicles per household": all(
                    h["vehicles"]["value"] is None or h["evacuating_vehicles"]["value"] <= h["vehicles"]["value"]
                    for h in hh),
                "carless households kept, needing transport": t["needs_transport_households"]
                == t["no_vehicle_households"] == sum(h["vehicles"]["value"] == 0 for h in hh),
                "no negative counts": all((h[k]["value"] or 0) >= 0 for h in hh
                                          for k in ("occupants", "vehicles", "evacuating_vehicles")),
                "engines available <= total": all(0 <= s["engines_available"] <= s["engines_total"]
                                                  for s in built["stations"]),
            }
            for name, passed in checks.items():
                self.stdout.write(f"  [{'ok' if passed else 'FAIL'}] {name}")
            if not all(checks.values()):
                failed.append(incident_id)
            for note in doc["notes"][:3]:
                self.stdout.write(f"  note: {note}")
            if len(doc["notes"]) > 3:
                self.stdout.write(f"  ... {len(doc['notes']) - 3} more notes in the snapshot document")
        if failed:
            raise CommandError(f"failed: {', '.join(failed)}")
