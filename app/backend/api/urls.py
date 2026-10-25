from django.urls import include, path, re_path

from .conditions import conditions, conditions_presets
from .demo import demo_decide, demo_routes
from .demo_realism import demo_crew_routes, demo_environment, demo_road_access, demo_wind
from .dispatch import decide
from .dispatch_area import dispatch_area
from .dispatch_households import dispatch_households
from .dispatch_runs import run_list, run_outcome
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
from .intel_feeds_api import intel_feed_poll, intel_feeds
from .geo_cache import imagery_tile, landfire_wcs, terrarium_tile
from .landscape_cache import landscape_cache
from .landscapes import landscape_list, landscape_package
from .live_active import live_active
from .live_broadcast import live_broadcast, live_snapshot
from .mobile_data import mobile_collection, mobile_document, register_device
from .scenario_weather import scenario_weather
from .sim_state import advice as sim_advice
from .sim_state import homes as sim_homes
from .sim_state import latest as sim_latest
from .sim_state import publish_run, tick_run
from .suppression_bases import suppression_bases
from .views import health
from .world import load_scenario, world_active, world_scenario, world_scenarios

SCENARIO_ID = r"(?P<scenario_id>scn_[0-9a-f]{8,40})"
FAMILY_ID = r"(?P<family_id>[0-9a-f]{24})"
MOBILE_COLLECTION = r"(?P<collection>[a-z][a-z0-9_]{0,47})"
MOBILE_DOCUMENT_ID = r"(?P<document_id>[0-9a-f]{24})"

urlpatterns = [
    path("health", health, name="health"),
    path("replay/explain", explain, name="replay-explain"),
    path("dispatch/decide", decide, name="dispatch-decide"),
    path("dispatch/area", dispatch_area, name="dispatch-area"),
    path("dispatch/households", dispatch_households, name="dispatch-households"),
    path("weather/scenario", scenario_weather, name="weather-scenario"),
    path("conditions", conditions, name="conditions"),
    path("conditions/presets", conditions_presets, name="conditions-presets"),
    path("suppression/bases", suppression_bases, name="suppression-bases"),
    path("demo/routes", demo_routes, name="demo-routes"),
    path("demo/decide", demo_decide, name="demo-decide"),
    path("demo/crew_routes", demo_crew_routes, name="demo-crew-routes"),
    path("demo/road_access", demo_road_access, name="demo-road-access"),
    path("demo/environment", demo_environment, name="demo-environment"),
    path("demo/wind", demo_wind, name="demo-wind"),
    path("dispatch/runs", run_list, name="dispatch-runs"),
    re_path(
        r"^dispatch/runs/(?P<session_id>[0-9a-f-]{36})/outcome$",
        run_outcome,
        name="dispatch-run-outcome",
    ),
    path("live", live_snapshot, name="live-snapshot"),
    path("live/active", live_active, name="live-active"),
    path("live/broadcast", live_broadcast, name="live-broadcast"),
    path("live/", include("api.live.urls")),
    path("sim-state/runs", publish_run, name="sim-state-publish"),
    re_path(r"^sim-state/runs/(?P<run_id>[^/]{1,64})/tick$", tick_run, name="sim-state-tick"),
    path("sim-state/latest", sim_latest, name="sim-state-latest"),
    path("sim-state/advice", sim_advice, name="sim-state-advice"),
    path("sim-state/homes", sim_homes, name="sim-state-homes"),
    path("families", create_family, name="family-create"),
    path("families/join", join_family, name="family-join"),
    re_path(rf"^families/{FAMILY_ID}$", family_detail, name="family-detail"),
    re_path(rf"^families/{FAMILY_ID}/meeting-points$", family_meeting_points, name="family-meeting-points"),
    re_path(rf"^families/{FAMILY_ID}/members/me$", family_member_me, name="family-member-me"),
    path("mobile/devices", register_device, name="mobile-devices"),
    re_path(rf"^mobile/data/{MOBILE_COLLECTION}$", mobile_collection, name="mobile-collection"),
    re_path(
        rf"^mobile/data/{MOBILE_COLLECTION}/{MOBILE_DOCUMENT_ID}$",
        mobile_document,
        name="mobile-document",
    ),
    path("intel/runs", intel_runs, name="intel-runs"),
    path("intel/ingest", intel_ingest, name="intel-ingest"),
    path("intel/documents", intel_documents, name="intel-documents"),
    re_path(
        r"^intel/documents/(?P<document_id>doc-[0-9a-f]{16})/extract$",
        intel_document_extract,
        name="intel-document-extract",
    ),
    path("intel/candidates", intel_candidates, name="intel-candidates"),
    path("intel/feeds", intel_feeds, name="intel-feeds"),
    re_path(r"^intel/feeds/(?P<feed>[a-z]{2,16})/poll$", intel_feed_poll, name="intel-feed-poll"),
    re_path(
        r"^intel/candidates/(?P<event_id>intel-[0-9a-f]{16})/review$",
        intel_candidate_review,
        name="intel-candidate-review",
    ),
    path("geo/landfire/wcs", landfire_wcs, name="geo-landfire-wcs"),
    re_path(r"^geo/terrarium/(?P<z>\d{1,2})/(?P<x>\d{1,8})/(?P<y>\d{1,8})\.png$", terrarium_tile, name="geo-terrarium"),
    re_path(r"^geo/imagery/(?P<z>\d{1,2})/(?P<y>\d{1,8})/(?P<x>\d{1,8})$", imagery_tile, name="geo-imagery"),
    path("landscapes/cache", landscape_cache, name="landscape-cache"),
    path("world/active", world_active, name="world-active"),
    path("world/scenarios", world_scenarios, name="world-scenarios"),
    re_path(rf"^world/scenarios/{SCENARIO_ID}$", world_scenario, name="world-scenario"),
    re_path(rf"^world/scenarios/{SCENARIO_ID}/load$", load_scenario, name="world-scenario-load"),
    re_path(r"^landscapes/?$", landscape_list, name="landscape-list"),
    re_path(r"^landscapes/(?P<region_id>[^/]{1,64})/?$", landscape_package, name="landscape-package"),
]
