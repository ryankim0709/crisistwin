"""Version 1 storage contracts for the illustrative frontend fire model."""

import math

from django.core.exceptions import ValidationError


FIRE_MODEL_V1 = {
    "id": "uniform-fuel-ellipse",
    "version": "1.0.0",
    "baseSpreadMetersPerSecond": 0.1,
    "headWindGainPerMeterPerSecond": 0.35,
    "backingWindReductionPerMeterPerSecond": 0.15,
}


def validate_object(value):
    if not isinstance(value, dict):
        raise ValidationError("Expected a JSON object.")


def require_keys(value, keys):
    validate_object(value)
    if set(value) != set(keys):
        raise ValidationError(f"Expected exactly these fields: {', '.join(keys)}.")


def require_number(value, minimum, maximum, label, exclusive_max=False):
    if (
        type(value) not in (int, float)
        or value < minimum
        or value > maximum
        or not math.isfinite(value)
        or (exclusive_max and value == maximum)
    ):
        raise ValidationError(f"{label} must be a finite number in its supported range.")


def validate_fire_inputs_v1(value):
    require_keys(value, ("origin", "windSpeedMph", "windFromDegrees"))
    require_keys(value["origin"], ("latitude", "longitude"))
    require_number(value["origin"]["latitude"], -80, 80, "Latitude")
    require_number(value["origin"]["longitude"], -180, 180, "Longitude")
    require_number(value["windSpeedMph"], 0, 40, "Wind speed (mph)")
    require_number(value["windFromDegrees"], 0, 360, "Wind from (degrees)", True)


def validate_run_snapshot_v1(value):
    require_keys(value, ("inputs", "model", "stepMinutes", "horizonMinutes"))
    validate_fire_inputs_v1(value["inputs"])
    if value["model"] != FIRE_MODEL_V1:
        raise ValidationError("Schema 1 requires uniform-fuel-ellipse 1.0.0 and its exact parameters.")
    if (
        type(value["stepMinutes"]) is not int
        or type(value["horizonMinutes"]) is not int
        or value["stepMinutes"] != 15
        or value["horizonMinutes"] != 120
    ):
        raise ValidationError("Schema 1 uses a 15-minute step and 120-minute horizon.")


def validate_fire_perimeter_v1(value):
    require_keys(value, ("type", "features"))
    if value["type"] != "FeatureCollection" or not isinstance(value["features"], list):
        raise ValidationError("Expected a GeoJSON FeatureCollection.")
    if not value["features"]:
        return
    if len(value["features"]) != 1:
        raise ValidationError("Schema 1 has at most one fire polygon.")
    feature = value["features"][0]
    require_keys(feature, ("type", "properties", "geometry"))
    require_keys(feature["properties"], ("elapsedMinutes",))
    require_keys(feature["geometry"], ("type", "coordinates"))
    if feature["type"] != "Feature" or feature["geometry"]["type"] != "Polygon":
        raise ValidationError("Expected a GeoJSON Polygon feature.")
    elapsed = feature["properties"]["elapsedMinutes"]
    if type(elapsed) is not int or elapsed not in range(15, 121, 15):
        raise ValidationError("Polygon elapsedMinutes must be 15, 30, ..., 120.")
    coordinates = feature["geometry"]["coordinates"]
    if not isinstance(coordinates, list) or len(coordinates) != 1:
        raise ValidationError("Expected one exterior ring without holes.")
    ring = coordinates[0]
    if not isinstance(ring, list) or len(ring) != 73:
        raise ValidationError("Expected a 72-segment ring with a closing coordinate.")
    for point in ring:
        if not isinstance(point, list) or len(point) != 2:
            raise ValidationError("Coordinates must be [longitude, latitude].")
        # Continuous longitudes at the date line are intentional in this model.
        require_number(point[0], -540, 540, "Continuous longitude")
        require_number(point[1], -90, 90, "Latitude")
    if ring[0] != ring[-1]:
        raise ValidationError("The polygon ring must be closed.")


def validate_road_geometry_v1(value):
    require_keys(value, ("type", "coordinates"))
    if value["type"] != "LineString":
        raise ValidationError("Road geometry must be a GeoJSON LineString.")
    points = value["coordinates"]
    if not isinstance(points, list) or not 2 <= len(points) <= 10000:
        raise ValidationError("A road needs 2 to 10,000 coordinates.")
    for point in points:
        if not isinstance(point, list) or len(point) != 2:
            raise ValidationError("Road coordinates must be [longitude, latitude].")
        require_number(point[0], -180, 180, "Longitude")
        require_number(point[1], -90, 90, "Latitude")
