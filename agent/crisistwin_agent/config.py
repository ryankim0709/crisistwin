"""Runtime configuration for the fire-watch agent.

Credentials are read from the environment and never written to disk, logs, or
tool results. ``ANTHROPIC_API_KEY`` is resolved by the Anthropic SDK itself; it
is checked here only so a missing key fails with a useful message instead of a
401 in the middle of a watch run.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from .ports import AgentError

DEFAULT_DOTENV_PATH = Path(__file__).resolve().parent.parent / ".env"
"""``agent/.env`` - gitignored, holds local credentials, never committed."""

Effort = Literal["low", "medium", "high", "xhigh", "max"]

DEFAULT_MODEL = "claude-opus-5"
DEFAULT_MAX_TOKENS = 16_000
DEFAULT_EFFORT: Effort = "high"
DEFAULT_MAX_TURNS = 24
DEFAULT_HORIZON_MINUTES = 180
DEFAULT_LOOKBACK_HOURS = 12

ENV_MODEL = "CRISISTWIN_AGENT_MODEL"
ENV_DETECTION_SOURCE = "CRISISTWIN_DETECTION_SOURCE"
ENV_FIXTURE_PATH = "CRISISTWIN_FIXTURE_PATH"
ENV_NODE_BIN = "CRISISTWIN_NODE_BIN"
ENV_HORIZON_MINUTES = "CRISISTWIN_HORIZON_MINUTES"
ENV_LOG_LEVEL = "CRISISTWIN_LOG_LEVEL"
ENV_MAX_TURNS = "CRISISTWIN_MAX_TURNS"
ENV_EFFORT = "CRISISTWIN_EFFORT"

SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01"
"""Routes a safety refusal to a fallback model by category instead of failing the run."""

VALID_EFFORTS = ("low", "medium", "high", "xhigh", "max")

VALID_HORIZON_MINUTES = (120, 180, 360)
"""Mirrors HORIZON_CHOICES in app/src/fire/spread.ts - the horizons the model supports."""

VALID_MOISTURE_PRESETS = ("critical", "dry", "moderate", "wet")
"""Mirrors MOISTURE_PRESETS ids in app/src/fire/spread.ts."""

MAX_WIND_SPEED_MPH = 100.0
MAX_LOOKBACK_HOURS = 168


def load_dotenv(path: Path | None = None, *, override: bool = False) -> list[str]:
    """Load ``KEY=value`` pairs from a ``.env`` file into the environment.

    ``agent/.env.example`` tells an operator to copy the file to ``agent/.env``,
    so something has to read it; a dozen lines of stdlib is cheaper than a
    dependency. An already-set environment variable wins unless ``override`` is
    set, so an explicit ``ANTHROPIC_API_KEY=... python -m crisistwin_agent``
    still beats the file.

    Returns the names of the variables it set - never the values, which are
    secrets and must not reach a log line.
    """
    path = path or DEFAULT_DOTENV_PATH
    if not path.is_file():
        return []

    loaded: list[str] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].lstrip()
        key, separator, value = line.partition("=")
        if not separator:
            continue
        key = key.strip()
        if not key:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if override or not os.environ.get(key):
            os.environ[key] = value
            loaded.append(key)
    return loaded


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        raise ValueError(f"{name}={raw!r} must be an integer") from None


class MissingCredentialError(AgentError):
    """A required credential is not set in the environment."""

    def __init__(self, variable: str, hint: str) -> None:
        super().__init__(f"{variable} is not set. {hint}")
        self.variable = variable


@dataclass(frozen=True, slots=True)
class AgentConfig:
    """Model and loop settings for one watch run."""

    model: str = DEFAULT_MODEL
    max_tokens: int = DEFAULT_MAX_TOKENS
    effort: Effort = DEFAULT_EFFORT
    max_turns: int = DEFAULT_MAX_TURNS
    """Hard ceiling on model turns per run, so an agent cannot loop without bound."""

    enable_refusal_fallbacks: bool = True
    """Server-side fallback routing for Opus 5 safety refusals. Disable for older SDKs."""

    request_timeout_seconds: float = 600.0

    def __post_init__(self) -> None:
        if self.max_turns < 1:
            raise ValueError("max_turns must be at least 1")
        if self.max_tokens < 1024:
            raise ValueError("max_tokens must leave room for a useful response")

    @classmethod
    def from_env(cls) -> AgentConfig:
        """Build config from the environment, falling back to the defaults above.

        A malformed value is an error, not a silent fallback: a typo in
        ``CRISISTWIN_MAX_TURNS`` should not quietly give a run a different budget
        than the operator asked for.
        """
        effort = os.environ.get(ENV_EFFORT, DEFAULT_EFFORT)
        if effort not in VALID_EFFORTS:
            raise ValueError(f"{ENV_EFFORT}={effort!r} must be one of {list(VALID_EFFORTS)}")
        return cls(
            model=os.environ.get(ENV_MODEL, DEFAULT_MODEL),
            effort=effort,  # type: ignore[arg-type]
            max_turns=_env_int(ENV_MAX_TURNS, DEFAULT_MAX_TURNS),
        )

    @staticmethod
    def require_anthropic_key() -> None:
        """Fail early and clearly when no Anthropic credential is available."""
        if not os.environ.get("ANTHROPIC_API_KEY") and not os.environ.get("ANTHROPIC_AUTH_TOKEN"):
            raise MissingCredentialError(
                "ANTHROPIC_API_KEY",
                "Export it, or sign in with `ant auth login` so the SDK picks up a stored profile. "
                "See agent/.env.example.",
            )

    def request_kwargs(self) -> dict[str, object]:
        """Extra keyword arguments shared by every Messages request in a run."""
        kwargs: dict[str, object] = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "thinking": {"type": "adaptive"},
            "output_config": {"effort": self.effort},
        }
        if self.enable_refusal_fallbacks:
            kwargs["betas"] = [SERVER_SIDE_FALLBACK_BETA]
            kwargs["fallbacks"] = "default"
        return kwargs
