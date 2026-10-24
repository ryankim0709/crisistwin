from django.urls import path

from . import views

urlpatterns = [
    path("devices", views.devices, name="live-devices"),
    path("incidents/<str:incident_id>/join", views.join, name="live-join"),
    path("incidents/<str:incident_id>/reports", views.incident_reports, name="live-reports"),
    path("incidents/<str:incident_id>/road-state", views.road_state, name="live-road-state"),
    path("incidents/<str:incident_id>/public-map", views.public_map, name="live-public-map"),
    path("incidents/<str:incident_id>/prompts", views.prompts, name="live-prompts"),
    path("incidents/<str:incident_id>/tasks", views.create_task, name="live-create-task"),
    path("incidents/<str:incident_id>/impact", views.impact, name="live-impact"),
    path("incidents/<str:incident_id>/route", views.route, name="live-route"),
    path("incidents/<str:incident_id>/situation", views.situation, name="live-situation"),
    path("incidents/<str:incident_id>/checkins", views.checkins, name="live-checkins"),
    path("incidents/<str:incident_id>/command", views.command, name="live-command"),
    path("incidents/<str:incident_id>/replan", views.replan, name="live-replan"),
    path("incidents/<str:incident_id>/drill", views.drill_action, name="live-drill"),
    path("incidents/<str:incident_id>/twin", views.twin, name="live-twin"),
    path("incidents/<str:incident_id>/twin/whatif", views.twin_whatif, name="live-twin-whatif"),
    path("me/reports", views.my_reports, name="live-my-reports"),
    path("me/tasks", views.my_tasks, name="live-my-tasks"),
    path("me/location", views.my_location, name="live-my-location"),
    path("me/destination", views.my_destination, name="live-my-destination"),
    path("reports/<str:report_id>/triage", views.triage, name="live-triage"),
    path("tasks/<str:task_id>", views.update_task, name="live-task"),
    path("checkins/<str:checkin_id>/help", views.checkin_help, name="live-checkin-help"),
    path("proposals/<str:proposal_id>/approve", views.approve_proposal, name="live-approve"),
    path("proposals/<str:proposal_id>/reject", views.reject_proposal, name="live-reject"),
]
