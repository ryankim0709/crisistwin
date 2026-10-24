from .live_init_db import Command as InitDbCommand


class Command(InitDbCommand):
    help = "Alias of live_init_db."
