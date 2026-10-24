from django.core.management.base import BaseCommand, CommandError
from livecore.drill import INCIDENT_ID

from api.live.common import ApiError
from api.live.drillcache import get_index
from api.live.fixtures import seed_reports
from api.live.views import set_drill


class Command(BaseCommand):
    help = "Start (or reset) the live drill clock; --seed adds labeled drill-fixture reports."

    def add_arguments(self, parser):
        parser.add_argument("--incident", default=INCIDENT_ID)
        parser.add_argument("--replay-start", help="Drill time to start from, e.g. 2018-11-08T15:00:00Z.")
        parser.add_argument("--speed", type=float, help="Drill seconds per wall second, 0..60.")
        parser.add_argument("--reset", action="store_true", help="Reset first (clears guidance, proposals, check-ins).")
        parser.add_argument("--seed", action="store_true", help="Insert synthetic drill-fixture reports.")

    def handle(self, *args, **options):
        incident_id = options["incident"]
        try:
            index = get_index(incident_id)
            if index.drill.incident_id != incident_id:
                raise CommandError(f"Unknown incident {incident_id}.")
            if options["reset"]:
                set_drill(incident_id, "reset")
                self.stdout.write("drill reset")
            state = set_drill(incident_id, "start", options["replay_start"], options["speed"])
        except ApiError as exc:
            raise CommandError(f"{exc.code}: {exc.detail}") from exc
        self.stdout.write(
            f"drill started: replay_now {state['replay_now']}, speed {state['speed']:g} ({state['label']})"
        )
        if options["seed"]:
            ids = seed_reports(index, incident_id)
            self.stdout.write(f"drill-fixture reports: {', '.join(ids)}")
