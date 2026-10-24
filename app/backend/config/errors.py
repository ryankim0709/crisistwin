import re

from django.views.debug import SafeExceptionReporterFilter


class MongoSafeExceptionReporterFilter(SafeExceptionReporterFilter):
    # WSGI request metadata may include environment variables in DEBUG mode.
    hidden_settings = re.compile(
        SafeExceptionReporterFilter.hidden_settings.pattern + "|MONGODB_URI", re.IGNORECASE
    )
