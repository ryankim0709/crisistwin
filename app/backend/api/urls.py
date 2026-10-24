from django.urls import include, path, re_path

from .dispatch import decide
from .dispatch_area import dispatch_area
from .explain import explain
from .families import create_family, family_detail, family_meeting_points, family_member_me, join_family
from .intel import (
    intel_candidate_review,
    intel_candidates,
    intel_document_extract,
    intel_documents,
    intel_ingest,
    intel_runs,
)
from .landscapes import landscape_list, landscape_package
from .live_broadcast import live_broadcast, live_snapshot
from .views import health

FAMILY_ID = r"(?P<family_id>[0-9a-f]{24})"

urlpatterns = [
    path("health", health, name="health"),
    path("replay/explain", explain, name="replay-explain"),
    path("dispatch/decide", decide, name="dispatch-decide"),
    path("dispatch/area", dispatch_area, name="dispatch-area"),
    path("live", live_snapshot, name="live-snapshot"),
    path("live/broadcast", live_broadcast, name="live-broadcast"),
    path("live/", include("api.live.urls")),
    path("families", create_family, name="family-create"),
    path("families/join", join_family, name="family-join"),
    re_path(rf"^families/{FAMILY_ID}$", family_detail, name="family-detail"),
    re_path(rf"^families/{FAMILY_ID}/meeting-points$", family_meeting_points, name="family-meeting-points"),
    re_path(rf"^families/{FAMILY_ID}/members/me$", family_member_me, name="family-member-me"),
    path("intel/runs", intel_runs, name="intel-runs"),
    path("intel/ingest", intel_ingest, name="intel-ingest"),
    path("intel/documents", intel_documents, name="intel-documents"),
    re_path(
        r"^intel/documents/(?P<document_id>doc-[0-9a-f]{16})/extract$",
        intel_document_extract,
        name="intel-document-extract",
    ),
    path("intel/candidates", intel_candidates, name="intel-candidates"),
    re_path(
        r"^intel/candidates/(?P<event_id>intel-[0-9a-f]{16})/review$",
        intel_candidate_review,
        name="intel-candidate-review",
    ),
    re_path(r"^landscapes/?$", landscape_list, name="landscape-list"),
    re_path(r"^landscapes/(?P<region_id>[^/]{1,64})/?$", landscape_package, name="landscape-package"),
]
