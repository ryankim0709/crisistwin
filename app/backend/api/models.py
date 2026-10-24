import uuid

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import MaxValueValidator
from django.db import models, transaction
from django.utils import timezone

from .validators import (
    validate_fire_inputs_v1,
    validate_fire_perimeter_v1,
    validate_object,
    validate_run_snapshot_v1,
    validate_road_geometry_v1,
)


class ValidatedModel(models.Model):
    """Normal ORM writes validate JSON; bulk writes require explicit validation."""

    class Meta:
        abstract = True

    def save(self, *args, **kwargs):
        self.full_clean()
        return super().save(*args, **kwargs)


class DatasetSnapshot(ValidatedModel):
    class SourceKind(models.TextChoices):
        SYNTHETIC = "synthetic", "Synthetic fixture"
        OBSERVED = "observed", "Observed source"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=200)
    version = models.CharField(max_length=100)
    source_kind = models.CharField(max_length=16, choices=SourceKind.choices)
    source_url = models.URLField(max_length=2000, blank=True)
    source_timestamp = models.DateTimeField(null=True, blank=True)
    retrieved_at = models.DateTimeField(null=True, blank=True)
    schema_version = models.PositiveSmallIntegerField(default=1)
    content = models.JSONField(validators=[validate_object], blank=True, default=dict)
    created_at = models.DateTimeField(auto_now_add=True)
    sealed_at = models.DateTimeField(null=True, blank=True, editable=False)

    def seal(self):
        """Finish importing relational inputs before scenarios reference this dataset."""
        with transaction.atomic():
            stored = DatasetSnapshot.objects.select_for_update().get(pk=self.pk)
            if stored.sealed_at is not None:
                self.sealed_at = stored.sealed_at
                return
            for record_type in (RoadNode, RoadSegment, Household, EvacuationDestination):
                for record in record_type.objects.filter(dataset_id=self.pk).iterator():
                    record.full_clean()
            self.sealed_at = timezone.now()
            self.save(update_fields=["sealed_at"])

    def clean(self):
        try:
            validate_object(self.content)
        except ValidationError as error:
            raise ValidationError({"content": error.messages}) from error

    class Meta:
        constraints = [
            models.CheckConstraint(condition=models.Q(schema_version=1), name="dataset_schema_v1"),
            models.CheckConstraint(
                condition=models.Q(source_kind__in=["synthetic", "observed"]),
                name="dataset_source_kind_valid",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(source_kind="synthetic")
                    | (models.Q(retrieved_at__isnull=False) & ~models.Q(source_url=""))
                ),
                name="observed_dataset_has_source",
            ),
        ]


class Scenario(ValidatedModel):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    name = models.CharField(max_length=200)
    region = models.CharField(max_length=200, blank=True)
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.SET_NULL)
    dataset = models.ForeignKey(DatasetSnapshot, null=True, blank=True, on_delete=models.PROTECT)
    schema_version = models.PositiveSmallIntegerField(default=1)
    inputs = models.JSONField(validators=[validate_fire_inputs_v1])
    assumptions = models.TextField(blank=True)
    evacuation_horizon_s = models.PositiveIntegerField(default=7200)
    evacuation_snapshot_interval_s = models.PositiveIntegerField(default=30)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        indexes = [models.Index(fields=["owner", "-updated_at"], name="scenario_owner_updated_idx")]
        constraints = [
            models.CheckConstraint(condition=models.Q(schema_version=1), name="scenario_schema_v1"),
            models.CheckConstraint(
                condition=~models.Q(parent=models.F("id")), name="scenario_not_own_parent"
            ),
            models.CheckConstraint(
                condition=models.Q(evacuation_horizon_s__gte=1, evacuation_horizon_s__lte=86400),
                name="scenario_evacuation_horizon",
            ),
            models.CheckConstraint(
                condition=models.Q(evacuation_snapshot_interval_s__gte=1)
                & models.Q(evacuation_snapshot_interval_s__lte=models.F("evacuation_horizon_s")),
                name="scenario_evacuation_interval",
            ),
        ]

    def clean(self):
        if self.dataset_id:
            dataset = DatasetSnapshot.objects.filter(pk=self.dataset_id).first()
            if dataset and dataset.sealed_at is None:
                raise ValidationError({"dataset": "Seal the dataset before using it in a scenario."})
        if not self._state.adding:
            previous = Scenario.objects.get(pk=self.pk)
            if previous.dataset_id != self.dataset_id and (
                self.evacuation_plans.exists() or self.road_events.exists()
            ):
                raise ValidationError({"dataset": "Create a new scenario to change a planned dataset."})
            if (
                isinstance(self.evacuation_horizon_s, int)
                and self.road_events.filter(time_s__gt=self.evacuation_horizon_s).exists()
            ):
                raise ValidationError({"evacuation_horizon_s": "Existing road events exceed this horizon."})
        if self.parent_id and self.parent_id != self.pk:
            parent_owner = (
                Scenario.objects.filter(pk=self.parent_id)
                .values_list("owner_id", flat=True)
                .first()
            )
            if parent_owner is not None and parent_owner != self.owner_id:
                raise ValidationError({"parent": "A parent scenario must have the same owner."})


class SimulationRun(ValidatedModel):
    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        RUNNING = "running", "Running"
        SUCCEEDED = "succeeded", "Succeeded"
        FAILED = "failed", "Failed"
        CANCELLED = "cancelled", "Cancelled"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    scenario = models.ForeignKey(Scenario, related_name="runs", on_delete=models.PROTECT)
    dataset = models.ForeignKey(DatasetSnapshot, null=True, blank=True, on_delete=models.PROTECT)
    schema_version = models.PositiveSmallIntegerField(default=1)
    input_snapshot = models.JSONField(validators=[validate_run_snapshot_v1])
    assumptions_snapshot = models.TextField(blank=True)
    random_seed = models.BigIntegerField(null=True, blank=True)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)
    error_message = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [models.Index(fields=["scenario", "-created_at"], name="run_scenario_created_idx")]
        constraints = [
            models.CheckConstraint(condition=models.Q(schema_version=1), name="run_schema_v1"),
            models.CheckConstraint(condition=models.Q(random_seed__isnull=True), name="fire_v1_no_seed"),
            models.CheckConstraint(
                condition=models.Q(dataset__isnull=True), name="fire_v1_no_dataset"
            ),
            models.CheckConstraint(
                condition=models.Q(status__in=["pending", "running", "succeeded", "failed", "cancelled"]),
                name="run_status_valid",
            ),
            models.CheckConstraint(
                condition=(
                    (models.Q(status="failed") & ~models.Q(error_message=""))
                    | (~models.Q(status="failed") & models.Q(error_message=""))
                ),
                name="run_failure_has_error",
            ),
        ]


class RunFrame(ValidatedModel):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    run = models.ForeignKey(SimulationRun, related_name="frames", on_delete=models.CASCADE)
    elapsed_minutes = models.PositiveSmallIntegerField()
    perimeter = models.JSONField(validators=[validate_fire_perimeter_v1])

    class Meta:
        ordering = ["elapsed_minutes"]
        constraints = [
            models.UniqueConstraint(fields=["run", "elapsed_minutes"], name="unique_run_frame_time"),
            models.CheckConstraint(
                condition=models.Q(elapsed_minutes__in=list(range(0, 121, 15))),
                name="fire_v1_frame_time",
            ),
        ]

    def clean(self):
        # clean() also runs after field validation fails, so avoid inspecting an invalid shape.
        try:
            validate_fire_perimeter_v1(self.perimeter)
        except ValidationError as error:
            raise ValidationError({"perimeter": error.messages}) from error
        features = self.perimeter["features"]
        if self.elapsed_minutes == 0:
            if features:
                raise ValidationError({"perimeter": "Frame zero must have an empty perimeter."})
        elif not features or features[0]["properties"]["elapsedMinutes"] != self.elapsed_minutes:
            raise ValidationError({"perimeter": "Polygon time must match the frame time."})


def validate_dataset_links(record, field_names):
    """Cross-record references must belong to the same versioned input graph."""
    for field_name in field_names:
        field = record._meta.get_field(field_name)
        related_id = getattr(record, field.attname)
        if related_id:
            dataset_id = (
                field.remote_field.model.objects.filter(pk=related_id)
                .values_list("dataset_id", flat=True)
                .first()
            )
            if dataset_id is not None and dataset_id != record.dataset_id:
                raise ValidationError({field_name: "Must belong to the same dataset."})


class DatasetRecord(ValidatedModel):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    dataset = models.ForeignKey(DatasetSnapshot, on_delete=models.PROTECT)
    key = models.CharField(max_length=100)
    label = models.CharField(max_length=200, blank=True)

    class Meta:
        abstract = True
        constraints = [
            models.UniqueConstraint(fields=["dataset", "key"], name="%(class)s_dataset_key"),
        ]


class LocatedDatasetRecord(DatasetRecord):
    latitude = models.DecimalField(max_digits=10, decimal_places=7)
    longitude = models.DecimalField(max_digits=10, decimal_places=7)

    class Meta(DatasetRecord.Meta):
        abstract = True
        constraints = DatasetRecord.Meta.constraints + [
            models.CheckConstraint(
                condition=models.Q(latitude__gte=-90, latitude__lte=90),
                name="%(class)s_latitude",
            ),
            models.CheckConstraint(
                condition=models.Q(longitude__gte=-180, longitude__lte=180),
                name="%(class)s_longitude",
            ),
        ]


class RoadNode(LocatedDatasetRecord):
    """A directed-network vertex, including household connectors and exits."""


class RoadSegment(DatasetRecord):
    source = models.ForeignKey(RoadNode, related_name="outgoing_roads", on_delete=models.PROTECT)
    target = models.ForeignKey(RoadNode, related_name="incoming_roads", on_delete=models.PROTECT)
    geometry = models.JSONField(validators=[validate_road_geometry_v1])
    length_m = models.DecimalField(max_digits=12, decimal_places=3)
    free_flow_speed_kph = models.DecimalField(max_digits=7, decimal_places=3)
    capacity_vehicles_per_hour = models.PositiveIntegerField()

    class Meta(DatasetRecord.Meta):
        constraints = DatasetRecord.Meta.constraints + [
            models.CheckConstraint(
                condition=~models.Q(source=models.F("target")), name="road_distinct_nodes"
            ),
            models.CheckConstraint(
                condition=models.Q(length_m__gt=0, length_m__lte=1000000), name="road_length_range"
            ),
            models.CheckConstraint(
                condition=models.Q(free_flow_speed_kph__gt=0, free_flow_speed_kph__lte=300),
                name="road_speed_range",
            ),
            models.CheckConstraint(
                condition=models.Q(capacity_vehicles_per_hour__gte=1, capacity_vehicles_per_hour__lte=100000),
                name="road_capacity_range",
            ),
        ]

    def clean(self):
        validate_dataset_links(self, ("source", "target"))
        try:
            validate_road_geometry_v1(self.geometry)
        except ValidationError as error:
            raise ValidationError({"geometry": error.messages}) from error
        for node_id, point in (
            (self.source_id, self.geometry["coordinates"][0]),
            (self.target_id, self.geometry["coordinates"][-1]),
        ):
            node = RoadNode.objects.filter(pk=node_id).first() if node_id else None
            if node and (
                abs(float(node.longitude) - point[0]) > 0.0000001
                or abs(float(node.latitude) - point[1]) > 0.0000001
            ):
                raise ValidationError({"geometry": "LineString endpoints must match source and target nodes."})


class Household(LocatedDatasetRecord):
    class CountsKind(models.TextChoices):
        SYNTHETIC = "synthetic", "Synthetic demo counts"
        ASSUMED = "assumed", "User-assumed counts"

    origin = models.ForeignKey(RoadNode, null=True, blank=True, on_delete=models.PROTECT)
    occupants = models.PositiveIntegerField()
    cars_available = models.PositiveIntegerField()
    seats_available = models.PositiveIntegerField(help_text="Total usable seats including drivers.")
    counts_kind = models.CharField(max_length=16, choices=CountsKind.choices, default=CountsKind.SYNTHETIC)

    class Meta(LocatedDatasetRecord.Meta):
        constraints = LocatedDatasetRecord.Meta.constraints + [
            models.CheckConstraint(
                condition=models.Q(counts_kind__in=["synthetic", "assumed"]), name="household_counts_kind"
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(cars_available=0, seats_available=0)
                    | (models.Q(cars_available__gt=0) & models.Q(seats_available__gte=models.F("cars_available")))
                ),
                name="household_available_seats",
            ),
        ]

    def clean(self):
        validate_dataset_links(self, ("origin",))


class EvacuationDestination(LocatedDatasetRecord):
    class Kind(models.TextChoices):
        SHELTER = "shelter", "Shelter"
        EXIT = "exit", "Exit from modeled area"

    node = models.ForeignKey(RoadNode, on_delete=models.PROTECT)
    kind = models.CharField(max_length=16, choices=Kind.choices)
    capacity_people = models.PositiveIntegerField(null=True, blank=True)
    capacity_vehicles = models.PositiveIntegerField(null=True, blank=True)
    throughput_vehicles_per_hour = models.PositiveIntegerField(null=True, blank=True)

    class Meta(LocatedDatasetRecord.Meta):
        constraints = LocatedDatasetRecord.Meta.constraints + [
            models.CheckConstraint(
                condition=(
                    models.Q(kind="shelter", capacity_people__isnull=False,
                             capacity_vehicles__isnull=False, throughput_vehicles_per_hour__isnull=True)
                    | models.Q(kind="exit", capacity_people__isnull=True,
                               capacity_vehicles__isnull=True, throughput_vehicles_per_hour__isnull=False,
                               throughput_vehicles_per_hour__gte=1)
                ),
                name="destination_capacity_by_kind",
            ),
        ]

    def clean(self):
        validate_dataset_links(self, ("node",))


class EvacuationPlan(ValidatedModel):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    scenario = models.ForeignKey(Scenario, related_name="evacuation_plans", on_delete=models.PROTECT)
    name = models.CharField(max_length=200)
    assumptions = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def clean(self):
        scenario = Scenario.objects.filter(pk=self.scenario_id).first() if self.scenario_id else None
        if scenario and (scenario.dataset_id is None or scenario.dataset.sealed_at is None):
            raise ValidationError({"scenario": "An evacuation plan needs a sealed scenario dataset."})
        if not self._state.adding:
            previous = EvacuationPlan.objects.get(pk=self.pk)
            if previous.scenario_id != self.scenario_id:
                raise ValidationError({"scenario": "Create a new plan to change its scenario."})


class HouseholdDeparture(ValidatedModel):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    plan = models.ForeignKey(EvacuationPlan, related_name="departures", on_delete=models.CASCADE)
    household = models.ForeignKey(Household, on_delete=models.PROTECT)
    departure_time_s = models.PositiveIntegerField(validators=[MaxValueValidator(86400)])
    participating_people = models.PositiveIntegerField()
    vehicles_used = models.PositiveIntegerField()
    seats_used = models.PositiveIntegerField(help_text="Seats in selected vehicles, including drivers.")
    destination = models.ForeignKey(EvacuationDestination, null=True, blank=True, on_delete=models.PROTECT)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["plan", "household"], name="one_departure_per_household"),
            models.CheckConstraint(condition=models.Q(departure_time_s__lte=86400), name="departure_time_range"),
            models.CheckConstraint(
                condition=models.Q(vehicles_used__lte=models.F("participating_people")), name="departure_has_drivers"
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(vehicles_used=0, seats_used=0)
                    | (models.Q(vehicles_used__gt=0) & models.Q(seats_used__gte=models.F("vehicles_used")))
                ),
                name="departure_selected_seats",
            ),
        ]

    def clean(self):
        plan = EvacuationPlan.objects.filter(pk=self.plan_id).select_related("scenario").first() if self.plan_id else None
        household = Household.objects.filter(pk=self.household_id).first() if self.household_id else None
        destination = EvacuationDestination.objects.filter(pk=self.destination_id).first() if self.destination_id else None
        if plan and household and plan.scenario.dataset_id != household.dataset_id:
            raise ValidationError({"household": "Must belong to the plan's scenario dataset."})
        if plan and destination and plan.scenario.dataset_id != destination.dataset_id:
            raise ValidationError({"destination": "Must belong to the plan's scenario dataset."})
        if household:
            for field, available in (
                ("participating_people", household.occupants),
                ("vehicles_used", household.cars_available),
                ("seats_used", household.seats_available),
            ):
                value = getattr(self, field)
                if isinstance(value, int) and value > available:
                    raise ValidationError({field: "Cannot exceed the household's available count."})


class RoadEvent(ValidatedModel):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    scenario = models.ForeignKey(Scenario, related_name="road_events", on_delete=models.CASCADE)
    road = models.ForeignKey(RoadSegment, on_delete=models.PROTECT)
    time_s = models.PositiveIntegerField()
    closed = models.BooleanField()

    class Meta:
        ordering = ["time_s", "road_id"]
        constraints = [
            models.UniqueConstraint(fields=["scenario", "road", "time_s"], name="one_road_event_at_time"),
        ]

    def clean(self):
        scenario = Scenario.objects.filter(pk=self.scenario_id).first() if self.scenario_id else None
        road = RoadSegment.objects.filter(pk=self.road_id).first() if self.road_id else None
        if scenario and road and (
            scenario.dataset_id != road.dataset_id or scenario.dataset.sealed_at is None
        ):
            raise ValidationError({"road": "Must belong to the scenario's sealed dataset."})
        if scenario and isinstance(self.time_s, int) and self.time_s > scenario.evacuation_horizon_s:
            raise ValidationError({"time_s": "Road events must fall within the evacuation horizon."})
