"""Poll the open live feeds once (cron-style); candidates arrive `unconfirmed` for planner review.

    python manage.py intel_poll_feeds --bbox -122.1 39.3 -121.0 40.2
    python manage.py intel_poll_feeds --feed nws --feed caltrans --districts 3 --incident camp-2018

There is no scheduler in the repo: run it from cron or by hand. Each feed keeps a minimum
interval (see `api.intel_feeds.FEEDS`); a feed polled too recently is reported and skipped.
"""

from api import intel_feeds as feeds
from api.intel_feeds_api import DEFAULT_INCIDENT, poll_feed, validate_poll
from django.core.management.base import BaseCommand, CommandError


class Command(BaseCommand):
    help = "Poll NWS alerts, Caltrans lane closures and WFIGS fires into /api/intel candidates."

    def add_arguments(self, parser):
        parser.add_argument(
            "--bbox",
            nargs="+",
            help="West South East North in degrees, or --bbox=w,s,e,n (required for wfigs).",
        )
        parser.add_argument("--feed", action="append", choices=sorted(feeds.FEEDS), help="Repeatable; default all.")
        parser.add_argument("--incident", default=DEFAULT_INCIDENT, help="Incident slug the candidates belong to.")
        parser.add_argument("--districts", help="Comma list of Caltrans districts (default INTEL_FEEDS_CALTRANS_DISTRICTS).")
        parser.add_argument("--area", help="Two-letter state for NWS when no --bbox is given.")

    def handle(self, *args, **options):
        raw: dict = {"incident": options["incident"]}
        if options["bbox"]:
            try:
                raw["bbox"] = [float(v) for v in ",".join(options["bbox"]).split(",")]
            except ValueError as exc:
                raise CommandError("--bbox must be west,south,east,north in degrees.") from exc
        if options["districts"]:
            try:
                raw["districts"] = [int(v) for v in options["districts"].split(",")]
            except ValueError as exc:
                raise CommandError("--districts must be a comma list of integers.") from exc
        if options["area"]:
            raw["area"] = options["area"].upper()
        failures = 0
        for feed in options["feed"] or list(feeds.FEEDS):
            validated, problem = validate_poll(feed, raw)
            if problem:
                self.stderr.write(f"{feed}: skipped, {problem}")
                failures += 1
                continue
            status, body = poll_feed(feed, validated)
            if status == 200:
                self.stdout.write(
                    f"{feed}: ok, {body['candidates']} candidates "
                    f"({body['created']} new, {body['updated']} updated, {body['unchanged']} reviewed) {body['stats']}"
                )
            elif status == 429:
                self.stdout.write(f"{feed}: skipped, {body['detail']}")
            else:
                self.stderr.write(f"{feed}: failed, {body['error']}: {body['detail']}")
                failures += 1
        if failures:
            raise CommandError(f"{failures} feed(s) failed.")
