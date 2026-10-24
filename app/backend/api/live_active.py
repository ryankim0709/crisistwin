"""``GET /api/live/active``: which incident phones should join on this hosted instance.

One active incident per hosted instance (ADR 0030), so phones never pick one. Unauthenticated:
it names the incident and says whether a responder invite code is needed; it carries no secret.
Today it is the configured drill; ADR 0030's scenario engine can change the settings it reads.
"""

from django.conf import settings
from django.http import JsonResponse
from django.views.decorators.http import require_GET

from livecore.drill import DRILL_LABEL, INCIDENT_ID, INCIDENT_NAME

ACTIVE_MODES = {"drill"}


def active_incident() -> dict:
    mode = getattr(settings, "LIVE_ACTIVE_MODE", "drill")
    return {
        "incident_id": getattr(settings, "LIVE_ACTIVE_INCIDENT_ID", "") or INCIDENT_ID,
        "name": getattr(settings, "LIVE_ACTIVE_NAME", "") or INCIDENT_NAME,
        "mode": mode if mode in ACTIVE_MODES else "drill",
        "label": getattr(settings, "LIVE_ACTIVE_LABEL", "") or DRILL_LABEL,
        # True when an invite code is configured, so responders must present it. False means
        # responder join is closed (the join endpoint answers 403); civilians need no code.
        "join": {"invite_required": bool(getattr(settings, "LIVE_INVITE_CODE", ""))},
    }


@require_GET
def live_active(request):
    response = JsonResponse(active_incident())
    response["Cache-Control"] = "no-store"
    return response
