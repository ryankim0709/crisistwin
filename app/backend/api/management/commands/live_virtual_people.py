import json
import time

from django.core.management.base import BaseCommand
from django.test import RequestFactory

from api.live import incidents
from api.live import virtual_people as vpeople
from api.live.common import live_setting


class Command(BaseCommand):
    help = ("Keep an incident's simulated people (virtual phones) moving on the drill clock when no console is "
            "open (docs/app-integration.md \"Simulated people\"). Optionally adds people first.")

    def add_arguments(self, parser):
        parser.add_argument("--incident", default=None, help="Incident id (default: the active incident).")
        parser.add_argument("--add", type=int, default=0, help="Add this many simulated people first (1-200).")
        parser.add_argument("--seed", type=int, default=None, help="Seed for --add (default: the run's, else 20181108).")
        parser.add_argument("--interval", type=float, default=2.0, help="Wall seconds between ticks.")
        parser.add_argument("--duration", type=float, default=0.0, help="Stop after this many wall seconds (0: never).")

    def handle(self, *args, **options):
        incident_id = options["incident"] or incidents.active_incident_id()
        if options["add"]:
            body = {"count": options["add"], **({"seed": options["seed"]} if options["seed"] is not None else {})}
            token = live_setting("LIVE_CONTROLLER_TOKEN")
            headers = {"HTTP_AUTHORIZATION": f"Bearer {token}"} if token else {}
            request = RequestFactory().post("/", data=json.dumps(body), content_type="application/json", **headers)
            response = vpeople.virtual_people(request, incident_id=incident_id)
            self.stdout.write(f"add: {response.status_code} {response.data.get('added', response.data)}")
        started = time.monotonic()
        while True:
            result = vpeople.tick(incident_id)
            if result:
                self.stdout.write(f"{result['ticked_to']}: {result['person_minutes']} person-minutes, "
                                  f"sent {result['sent']}, twin {result['twin']}")
            if options["duration"] and time.monotonic() - started >= options["duration"]:
                return
            time.sleep(options["interval"])
