from django.urls import path

from .explain import explain
from .views import health

urlpatterns = [
    path("health", health, name="health"),
    path("replay/explain", explain, name="replay-explain"),
]
