from django.core.management.base import BaseCommand

from api.live import schema
from api.mongodb import get_database


class Command(BaseCommand):
    help = "Create or update the live_* MongoDB collections, validators and indexes (idempotent)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--drop-drill-data",
            action="store_true",
            help="Drop all live drill data first (reports, tasks, guidance, ...); device tokens are kept.",
        )

    def handle(self, *args, **options):
        db = get_database()
        for line in schema.apply(db, drop_drill_data=options["drop_drill_data"]):
            self.stdout.write(line)
        self.stdout.write(self.style.SUCCESS(f"live collections ready in database {db.name}"))
