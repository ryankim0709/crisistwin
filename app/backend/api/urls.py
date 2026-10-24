from django.urls import path, re_path

from .dispatch import decide
from .dispatch_area import dispatch_area
from .explain import explain
from .landscapes import landscape_list, landscape_package
from .views import health

urlpatterns = [
    path("health", health, name="health"),
    path("replay/explain", explain, name="replay-explain"),
    path("dispatch/decide", decide, name="dispatch-decide"),
    path("dispatch/area", dispatch_area, name="dispatch-area"),
    re_path(r"^landscapes/?$", landscape_list, name="landscape-list"),
    re_path(r"^landscapes/(?P<region_id>[^/]{1,64})/?$", landscape_package, name="landscape-package"),
]
