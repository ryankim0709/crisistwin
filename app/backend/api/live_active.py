"""``/api/live/active``: the one incident phones and consoles follow on this hosted instance.

One active incident per hosted instance (ADR 0030 item 5, docs/adr/0047-active-incident.md), so
phones never pick one.

- ``GET`` (unauthenticated): names the incident and says whether a responder invite code is
  needed; it carries no secret. Stored in MongoDB ``live_active``; the settings default (Camp)
  until a controller switches.
- ``POST`` (controller): ``{"package_id": "pkg_<hex>"}`` or ``{"incident_id": "camp-2018-drill"}``
  makes that drill the active incident after checking that it loads. Returns
  ``{active, changed}``. Batch evaluation runs never go through here.
"""

from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt

from .live import incidents, snapshots, twin_service
from .live.auth import Principal, live_view
from .live.common import ApiError, json_body, ok, wall_now
from .live.controller import log_decision
from .live.drillcache import get_index


def active_incident() -> dict:
    return incidents.active_json()


@live_view(["POST"], roles={"controller"})
def switch_active(request, principal: Principal):
    body = json_body(request)
    package_id, incident_id = body.get("package_id"), body.get("incident_id")
    if (package_id is None) == (incident_id is None):
        raise ApiError(400, "invalid_request", "Give exactly one of `package_id` or `incident_id`.")
    if package_id is not None:
        if not isinstance(package_id, str):
            raise ApiError(400, "invalid_request", "`package_id` must be a string.")
        source = incidents.package_source(package_id)
        if source is None:
            raise ApiError(404, "not_found", "Unknown package.")
    else:
        if not isinstance(incident_id, str):
            raise ApiError(400, "invalid_request", "`incident_id` must be a string.")
        source = incidents.source_for(incident_id)
        if source is None:
            raise ApiError(404, "not_found", "Unknown incident.")
    get_index(source.incident_id)  # it must load before phones are pointed at it (503 otherwise)
    previous = incidents.active_incident_id()
    now = wall_now()
    changed = incidents.activate(source, "controller", now)
    if changed:
        log_decision(source.incident_id, "controller", "incident_activated", now, note=f"Was {previous}")
    twin_service.warm(source.incident_id)
    snapshots.ensure_background(source.incident_id)  # resource snapshot, if the incident has none yet
    return ok({"active": incidents.active_json(), "changed": changed})


@csrf_exempt
def live_active(request):
    if request.method == "POST":
        return switch_active(request)
    if request.method != "GET":
        return JsonResponse({"error": "method_not_allowed"}, status=405)
    response = JsonResponse(active_incident())
    response["Cache-Control"] = "no-store"
    return response
