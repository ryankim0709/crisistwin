"""Create or check the Atlas Vector Search index behind the dispatcher's similar situations.

    python manage.py dispatch_vector_index

The server also creates it on first use; run this to set it up ahead of a demo and see when
Atlas reports it READY. See docs/adr/0032-atlas-situation-search.md.
"""

from django.core.management.base import BaseCommand, CommandError
from pymongo.errors import PyMongoError

from api import dispatch_situations


class Command(BaseCommand):
    help = "Create or check the dispatch_situations vector search index (MongoDB Atlas)."

    def handle(self, *args, **options):
        try:
            status = dispatch_situations.ensure_index()
        except PyMongoError as exc:
            raise CommandError(
                f"Could not create the vector index ({type(exc).__name__}). It needs MongoDB Atlas "
                "or Atlas local with Search."
            ) from exc
        self.stdout.write(f"{dispatch_situations.COLLECTION}.{dispatch_situations.INDEX_NAME}: {status}")
