from django.urls import path, re_path

from .dispatch import decide
from .explain import explain
from .families import create_family, family_detail, family_meeting_points, family_member_me, join_family
from .landscapes import landscape_list, landscape_package
from .live import live_broadcast, live_snapshot
from .views import health

FAMILY_ID = r"(?P<family_id>[0-9a-f]{24})"

urlpatterns = [
    path("health", health, name="health"),
    path("replay/explain", explain, name="replay-explain"),
    path("dispatch/decide", decide, name="dispatch-decide"),
    path("live", live_snapshot, name="live-snapshot"),
    path("live/broadcast", live_broadcast, name="live-broadcast"),
    path("families", create_family, name="family-create"),
    path("families/join", join_family, name="family-join"),
    re_path(rf"^families/{FAMILY_ID}$", family_detail, name="family-detail"),
    re_path(rf"^families/{FAMILY_ID}/meeting-points$", family_meeting_points, name="family-meeting-points"),
    re_path(rf"^families/{FAMILY_ID}/members/me$", family_member_me, name="family-member-me"),
    re_path(r"^landscapes/?$", landscape_list, name="landscape-list"),
    re_path(r"^landscapes/(?P<region_id>[^/]{1,64})/?$", landscape_package, name="landscape-package"),
]
