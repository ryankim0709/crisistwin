import uuid

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models

from .validators import (
    validate_fire_inputs_v1,
    validate_fire_perimeter_v1,
    validate_object,
    validate_run_snapshot_v1,
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
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        indexes = [models.Index(fields=["owner", "-updated_at"], name="scenario_owner_updated_idx")]
        constraints = [
            models.CheckConstraint(condition=models.Q(schema_version=1), name="scenario_schema_v1"),
            models.CheckConstraint(
                condition=~models.Q(parent=models.F("id")), name="scenario_not_own_parent"
            ),
        ]

    def clean(self):
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
