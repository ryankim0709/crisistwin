"""The :class:`~crisistwin_agent.ports.FireSpreadModel` adapter for the real fire model.

The fire model itself is the TypeScript in ``app/src/fire/``: Rothermel (1972) surface
spread over Scott & Burgan fuels, propagated as a minimum-travel-time field. It is not
reimplemented here and must not be - ``AGENTS.md`` rules out a second implementation of an
agreed model, and a Python copy would drift from the one the map draws.

This module drives that model instead. It spawns ``agent/bridge/fire-bridge.mjs`` as a
one-shot sidecar, hands it one JSON request on stdin, reads one JSON response from stdout,
and converts the run into the domain's :class:`~crisistwin_agent.domain.SpreadProjection`.
Nothing here computes fire behaviour; if the sidecar cannot answer, the port raises.

Units at this boundary
----------------------
The sidecar speaks the model's own units and converts nothing:

- ground metres and square metres (``maxReachMeters``, ``burnedAreaSquareMeters``),
- elapsed simulation minutes from ignition (``elapsedMinutes``), never wall-clock time,
- miles per hour for the open 20-foot wind, and meteorological degrees for its direction
  (the bearing the wind blows *from*),
- WGS84 decimal degrees for coordinates, in GeoJSON's ``[longitude, latitude]`` order
  inside the perimeter geometry.

One value crosses in Imperial units, because the Rothermel equations are published that
way and ``app/src/fire/rothermel.ts`` keeps them that way: ``headRateFeetPerMinute``. It
is converted to metres per minute exactly once, here, by :data:`METERS_PER_FOOT`. Nothing
else is converted on either side of the pipe.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
from pathlib import Path
from typing import Any, Final

from ..config import ENV_NODE_BIN, VALID_MOISTURE_PRESETS
from ..domain import (
    DetectionCluster,
    Evidence,
    GeoPoint,
    SpreadFrame,
    SpreadProjection,
    WeatherAssumption,
    utc_now,
)
from ..ports import NonBurnableIgnitionError, OutOfCoverageError, PortUnavailableError

SOURCE_ID: Final = "node-fire-bridge"
"""What a :class:`PortUnavailableError` names as the thing that could not answer."""

SOURCE_NAME: Final = "CrisisTwin Rothermel surface fire model (app/src/fire, run over the Node bridge)"

DEFAULT_BRIDGE_SCRIPT: Final = Path(__file__).resolve().parents[2] / "bridge" / "fire-bridge.mjs"

METERS_PER_FOOT: Final = 0.3048
"""The only unit conversion in this adapter: Rothermel head rate, feet/min -> metres/min."""

DEFAULT_MIDFLAME_ADJUSTMENT: Final = 0.5
"""Mirrors DEFAULT_MIDFLAME_ADJUSTMENT in app/src/fire/spread.ts (Albini & Baughman 1979)."""

FIRE_STEP_MINUTES: Final = 15
"""Mirrors FIRE_STEP_MINUTES in app/src/fire/spread.ts."""

MAX_LENGTH_TO_BREADTH: Final = 8.0
"""Mirrors MAX_LENGTH_TO_BREADTH in app/src/fire/rothermel.ts; reported when it binds."""

# Grid half-width, mirroring radiusFor() in app/src/fire/FireSimulatorPage.tsx. This is a
# download-size heuristic, not model physics: big enough for a fast run over the horizon,
# bounded so one fetch stays small.
ASSUMED_FAST_SPREAD_METERS_PER_MINUTE: Final = 40.0
MIN_RADIUS_METERS: Final = 3_000.0
MAX_RADIUS_METERS: Final = 12_000.0

DEFAULT_TIMEOUT_SECONDS: Final = 120.0
"""Budget for the sidecar's LANDFIRE and terrain fetches plus the solve."""

SUBPROCESS_GRACE_SECONDS: Final = 15.0
"""Head start the sidecar gets over the subprocess kill, so it can report its own timeout."""

TIMEOUT_ENV_VAR: Final = "CRISISTWIN_FIRE_BRIDGE_TIMEOUT_MS"

STDERR_TAIL_CHARS: Final = 1_500

MODEL_LIMITATIONS: Final[tuple[str, ...]] = (
    "Surface fire only: crown fire is not modelled.",
    "No spotting or ember transport ahead of the front.",
    "No suppression: this is a free-burning fire with no crews, aircraft or retardant.",
    "No structure-to-structure urban spread, so a fire that reaches the edge of the vegetation "
    "simply stops - which understates risk at the wildland-urban interface.",
    "Wind is uniform over the grid and constant in time; there is no diurnal weather change.",
    "Fuel moisture is uniform over the grid, taken from a standard Scott & Burgan preset.",
    "Fuel is LANDFIRE LF2025 FBFM40, a 2025 mapped product, not an observation of today's vegetation.",
    "Coverage is the contiguous United States only, the extent over which LANDFIRE publishes this layer.",
)
"""What the model genuinely does not cover, per the fire model section of README.md."""


def radius_for_horizon(horizon_minutes: int) -> float:
    """Ground radius of the landscape to fetch, in metres, for a horizon in minutes."""
    return min(max(horizon_minutes * ASSUMED_FAST_SPREAD_METERS_PER_MINUTE, MIN_RADIUS_METERS), MAX_RADIUS_METERS)


class NodeFireBridge:
    """Runs the TypeScript fire model in a Node sidecar and returns a domain projection.

    ``model_id`` is the model's stable identity; each projection additionally records the
    exact model version that produced it, as the sidecar reported it.
    """

    model_id: str = "rothermel-1972-mtt"

    def __init__(
        self,
        *,
        node_executable: str | None = None,
        bridge_script: Path | None = None,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        midflame_adjustment: float = DEFAULT_MIDFLAME_ADJUSTMENT,
        step_minutes: int = FIRE_STEP_MINUTES,
        ground_radius_meters: float | None = None,
    ) -> None:
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        if not 0.0 <= midflame_adjustment <= 1.0:
            raise ValueError("midflame_adjustment is a share of the open wind, so it is within [0, 1]")
        if step_minutes < 1:
            raise ValueError("step_minutes must be at least one simulation minute")
        if ground_radius_meters is not None and ground_radius_meters <= 0:
            raise ValueError("ground_radius_meters must be positive")

        self.node_executable = node_executable or os.environ.get(ENV_NODE_BIN) or "node"
        self.bridge_script = Path(bridge_script) if bridge_script else DEFAULT_BRIDGE_SCRIPT
        self.timeout_seconds = timeout_seconds
        self.midflame_adjustment = midflame_adjustment
        self.step_minutes = step_minutes
        self.ground_radius_meters = ground_radius_meters

    def project(
        self,
        ignition: DetectionCluster,
        weather: WeatherAssumption,
        horizon_minutes: int,
    ) -> SpreadProjection:
        """Project spread from a detection cluster's centroid. See the port for the contract."""
        if weather.moisture_preset not in VALID_MOISTURE_PRESETS:
            raise ValueError(
                f"moisture_preset {weather.moisture_preset!r} is not one of {list(VALID_MOISTURE_PRESETS)}"
            )
        if horizon_minutes < 1:
            raise ValueError("horizon_minutes must be at least one simulation minute")

        origin = ignition.centroid
        radius_meters = self.ground_radius_meters or radius_for_horizon(horizon_minutes)
        request = {
            "origin": {"latitude": origin.latitude, "longitude": origin.longitude},
            "windSpeedMph": weather.wind_speed_mph,
            "windFromDegrees": weather.wind_from_degrees,
            "moisturePresetId": weather.moisture_preset,
            "midflameAdjustment": self.midflame_adjustment,
            "stepMinutes": self.step_minutes,
            "horizonMinutes": horizon_minutes,
            "groundRadiusMeters": radius_meters,
        }
        payload = json.dumps(request, sort_keys=True, separators=(",", ":"))
        run = self._invoke(payload)
        return self._to_projection(run, payload, origin, weather, radius_meters)

    # -- sidecar -----------------------------------------------------------------

    def _invoke(self, payload: str) -> dict[str, Any]:
        """Run the sidecar once and return its ``run`` object, or raise a port error."""
        if not self.bridge_script.is_file():
            raise PortUnavailableError(SOURCE_ID, f"the sidecar {self.bridge_script} is missing")

        environment = dict(os.environ)
        environment[TIMEOUT_ENV_VAR] = str(int(self.timeout_seconds * 1000))
        # Fixed argv, no shell: the scenario crosses on stdin, so nothing user-supplied
        # reaches a command line.
        try:
            completed = subprocess.run(
                [self.node_executable, str(self.bridge_script)],
                input=payload,
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds + SUBPROCESS_GRACE_SECONDS,
                env=environment,
                check=False,
            )
        except FileNotFoundError as exc:
            raise PortUnavailableError(
                SOURCE_ID,
                f"Node executable {self.node_executable!r} was not found; set {ENV_NODE_BIN} to its path",
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise PortUnavailableError(
                SOURCE_ID,
                f"the sidecar did not answer within {self.timeout_seconds + SUBPROCESS_GRACE_SECONDS:.0f} s "
                "and was killed",
            ) from exc

        stderr = _tail(completed.stderr)
        if completed.returncode != 0:
            raise PortUnavailableError(
                SOURCE_ID,
                f"the sidecar exited with status {completed.returncode}. Node stderr: {stderr}",
            )
        try:
            response = json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            raise PortUnavailableError(
                SOURCE_ID,
                f"the sidecar wrote something that is not JSON on stdout ({exc}). Node stderr: {stderr}",
            ) from exc
        if not isinstance(response, dict):
            raise PortUnavailableError(SOURCE_ID, f"the sidecar response is not a JSON object. Node stderr: {stderr}")

        if not response.get("ok"):
            self._raise_for_error(response.get("error"), stderr)

        run = response.get("run")
        if not isinstance(run, dict):
            raise PortUnavailableError(SOURCE_ID, f"the sidecar reported success with no run. Node stderr: {stderr}")
        return run

    @staticmethod
    def _raise_for_error(error: Any, stderr: str) -> None:
        """Map the sidecar's failure onto a port exception. Never returns."""
        detail = error if isinstance(error, dict) else {}
        kind = detail.get("type")
        message = str(detail.get("message") or "the model did not say why it failed")
        if kind == "non_burnable":
            raise NonBurnableIgnitionError(message)
        if kind == "out_of_coverage":
            raise OutOfCoverageError(SOURCE_ID, message)
        # "unavailable" and anything unrecognised: the port could not answer, and the agent
        # must account for a missing projection rather than receive an invented one.
        raise PortUnavailableError(SOURCE_ID, f"{message} Node stderr: {stderr}")

    # -- conversion --------------------------------------------------------------

    def _to_projection(
        self,
        run: dict[str, Any],
        payload: str,
        origin: GeoPoint,
        weather: WeatherAssumption,
        radius_meters: float,
    ) -> SpreadProjection:
        model = _require_mapping(run.get("model"), "run.model")
        scenario = _require_mapping(run.get("scenario"), "run.scenario")
        ignition_conditions = _require_mapping(run.get("ignition"), "run.ignition")
        spread = _require_mapping(ignition_conditions.get("spread"), "run.ignition.spread")

        model_id = f"{model.get('id', self.model_id)}@{model.get('version', 'unknown')}"
        frames = _frames_of(run.get("frames"))

        head_rate_feet_per_minute = _optional_number(spread.get("headRateFeetPerMinute"))
        head_rate_meters_per_minute = (
            head_rate_feet_per_minute * METERS_PER_FOOT if head_rate_feet_per_minute is not None else None
        )

        compute_ms = _optional_number(run.get("computeMilliseconds"))
        cell_size = _optional_number(run.get("cellSizeMeters"))
        note = (
            f"Simulated with {model.get('surfaceSpread', 'Rothermel (1972)')} over "
            f"{model.get('fuelModels', 'Scott & Burgan (2005) fuel models')}, on LANDFIRE LF2025 FBFM40 fuels "
            f"and 3DEP-derived terrain within a {radius_meters / 1000:.1f} km ground radius"
            + (f" at {cell_size:.1f} m cells" if cell_size is not None else "")
            + (f"; solved in {compute_ms:.0f} ms." if compute_ms is not None else ".")
        )

        return SpreadProjection(
            run_id=_run_id(payload, model_id),
            model_id=model_id,
            ignition=origin,
            weather=weather,
            step_minutes=int(_require_number(scenario.get("stepMinutes"), "run.scenario.stepMinutes")),
            horizon_minutes=int(_require_number(scenario.get("horizonMinutes"), "run.scenario.horizonMinutes")),
            frames=frames,
            evidence=Evidence(
                kind="simulation",
                source_id=SOURCE_ID,
                source_name=SOURCE_NAME,
                retrieved_at=utc_now(),
                note=note,
            ),
            limitations=_limitations_for(run, spread),
            fuel_label=_optional_text(ignition_conditions.get("fuelLabel")),
            head_rate_meters_per_minute=head_rate_meters_per_minute,
            burnable_fraction=_optional_number(run.get("burnableFraction")),
            reached_edge=bool(run.get("reachedEdge", False)),
        )


def _run_id(payload: str, model_id: str) -> str:
    """A stable id for this run.

    The model is deterministic over a scenario and landscape, so the same request against
    the same model version gets the same id, and two tool calls with identical inputs do
    not look like two different findings.
    """
    digest = hashlib.sha256(f"{model_id}\n{payload}".encode()).hexdigest()
    return f"spread_{digest[:12]}"


def _limitations_for(run: dict[str, Any], spread: dict[str, Any]) -> tuple[str, ...]:
    """The standing model limitations, plus the ones this particular run actually hit."""
    limitations = list(MODEL_LIMITATIONS)
    if run.get("reachedEdge"):
        limitations.append(
            "The fire reached the edge of the modelled area before the horizon, so this footprint is "
            "truncated at the grid boundary and the run understates the final extent."
        )
    if spread.get("beyondValidatedWind"):
        limitations.append(
            "The effective wind is past the range Rothermel (1972) was validated over, so the head rate "
            "is an extrapolation reported rather than enforced."
        )
    length_to_breadth = _optional_number(spread.get("lengthToBreadth"))
    if length_to_breadth is not None and length_to_breadth >= MAX_LENGTH_TO_BREADTH:
        limitations.append(
            f"The spread ellipse is capped at {MAX_LENGTH_TO_BREADTH:.0f}:1 as FARSITE does, so flanking and "
            "backing spread are a very small fraction of the head rate at this wind."
        )
    return tuple(limitations)


def _frames_of(value: Any) -> tuple[SpreadFrame, ...]:
    """Convert the run's frames, wrapping each frame's perimeter array in a FeatureCollection."""
    if not isinstance(value, list) or not value:
        raise _malformed("run.frames is missing or empty")
    frames: list[SpreadFrame] = []
    for index, raw in enumerate(value):
        frame = _require_mapping(raw, f"run.frames[{index}]")
        perimeters = frame.get("perimeters")
        if not isinstance(perimeters, list):
            raise _malformed(f"run.frames[{index}].perimeters is not an array of GeoJSON features")
        elapsed = _require_number(frame.get("elapsedMinutes"), f"run.frames[{index}].elapsedMinutes")
        frames.append(
            SpreadFrame(
                elapsed_minutes=int(elapsed),
                # The model emits one Feature per disjoint burned patch; the domain carries a
                # FeatureCollection so a split footprint stays one frame.
                perimeter={"type": "FeatureCollection", "features": perimeters},
                burned_area_square_meters=_require_number(
                    frame.get("burnedAreaSquareMeters"), f"run.frames[{index}].burnedAreaSquareMeters"
                ),
                max_reach_meters=_require_number(frame.get("maxReachMeters"), f"run.frames[{index}].maxReachMeters"),
            )
        )
    return tuple(frames)


def _malformed(detail: str) -> PortUnavailableError:
    return PortUnavailableError(SOURCE_ID, f"the model run came back malformed: {detail}")


def _require_mapping(value: Any, field_name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _malformed(f"{field_name} is not an object")
    return value


def _require_number(value: Any, field_name: str) -> float:
    number = _optional_number(value)
    if number is None:
        raise _malformed(f"{field_name} is not a finite number ({value!r})")
    return number


def _optional_number(value: Any) -> float | None:
    """``None`` for anything the model did not report, so a gap never becomes a zero."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if number == number and number not in (float("inf"), float("-inf")) else None


def _optional_text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _tail(text: str | None, limit: int = STDERR_TAIL_CHARS) -> str:
    if not text:
        return "(empty)"
    stripped = text.strip()
    return stripped if len(stripped) <= limit else f"...{stripped[-limit:]}"
