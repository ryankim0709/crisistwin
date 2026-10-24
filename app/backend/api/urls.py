from django.urls import path

from .dispatch import decide
from .explain import explain
from .views import health

urlpatterns = [
    path("health", health, name="health"),
    path("replay/explain", explain, name="replay-explain"),
    path("dispatch/decide", decide, name="dispatch-decide"),
]
