from django.apps import AppConfig
from django.conf import settings


class ApiConfig(AppConfig):
    name = "api"

    def ready(self) -> None:
        if not settings.API_THROTTLES:
            # Every throttle in this API subclasses SimpleRateThrottle (AnonRateThrottle); with
            # throttles off (local development, settings.API_THROTTLES) none of them limits.
            from rest_framework.throttling import SimpleRateThrottle

            SimpleRateThrottle.allow_request = lambda self, request, view: True  # type: ignore[method-assign]
