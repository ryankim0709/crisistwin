"""Headless with/without comparison of acting on the 2018 ground record (simulated experiment).

    python manage.py live_compare_record --confirm-delay-min 5 --out /tmp/record-compare

Writes ``<out>.json`` and ``<out>.md``. See ``api.live.record_compare`` and docs/live-reports.md
"Proposals and the approval policy" ("Record comparison harness"). Writes nothing to MongoDB and
needs no running server: it reads the drill bundle, the ground record and the twin inputs from
the repository (``MONGODB_URI`` must still be set for Django settings).
"""

import json
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from api.live import record_compare, twin_service
from api.live.drillcache import get_index
from livecore.drill import INCIDENT_ID


class Command(BaseCommand):
    help = ("Simulated planning experiment: the live twin + planner with and without a controller acting on "
            "the 2018 ground record.")

    def add_arguments(self, parser):
        parser.add_argument("--confirm-delay-min", type=float, default=record_compare.DEFAULT_CONFIRM_DELAY_MIN,
                            help="N: drill minutes from a record entry's time to the controller's confirm (default 5).")
        parser.add_argument("--start", default=record_compare.DEFAULT_START, help="Drill time, UTC ISO (default 14:30Z).")
        parser.add_argument("--end", default=record_compare.DEFAULT_END, help="Drill time, UTC ISO (default 18:00Z).")
        parser.add_argument("--seed", type=int, default=twin_service.TWIN_SEED, help="Twin TrafficParams.seed (default 7).")
        parser.add_argument("--variants", default="A,B,B_free", help="Comma list of A, B, B_free.")
        parser.add_argument("--checkpoints", default=",".join(record_compare.DEFAULT_CHECKPOINTS),
                            help="Comma list of UTC ISO drill times for arrival counts.")
        parser.add_argument("--sample-s", type=int, default=record_compare.DEFAULT_SAMPLE_S,
                            help="Drill seconds between samples and fire-estimate checks (default 60).")
        parser.add_argument("--out", default="live-compare-record",
                            help="Output path without extension; writes .json and .md.")

    def handle(self, *args, **options):
        if options["confirm_delay_min"] < 0:
            raise CommandError("--confirm-delay-min must be >= 0.")
        if options["sample_s"] < 10:
            raise CommandError("--sample-s must be at least the twin step (10 s).")
        variants = [v.strip() for v in options["variants"].split(",") if v.strip()]
        try:
            report = record_compare.compare(
                get_index(INCIDENT_ID),
                start_iso=options["start"], end_iso=options["end"], confirm_delay_min=options["confirm_delay_min"],
                seed=options["seed"], variants=variants,
                checkpoints_iso=[c.strip() for c in options["checkpoints"].split(",") if c.strip()],
                sample_s=options["sample_s"], progress=self.stderr.write,
            )
        except (ValueError, RuntimeError) as exc:
            raise CommandError(str(exc)) from exc
        out = Path(options["out"])
        out.parent.mkdir(parents=True, exist_ok=True)
        json_path, md_path = Path(f"{out}.json"), Path(f"{out}.md")
        json_path.write_text(json.dumps(report, indent=2, default=str) + "\n")
        md_path.write_text(record_compare.markdown(report))
        self.stdout.write(f"wrote {json_path} and {md_path}")
