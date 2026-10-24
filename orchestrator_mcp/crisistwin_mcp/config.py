"""Runtime configuration for the controller MCP server, from the environment.

The controller token is read from the environment, sent only in the ``Authorization`` header,
and never written to logs, tool results or ``repr``.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field

ENV_API_BASE = "CRISISTWIN_API_BASE"
ENV_TOKEN = "CRISISTWIN_CONTROLLER_TOKEN"
ENV_AGENT_NAME = "ORCH_AGENT_NAME"
ENV_ALLOW_CLOCK = "ORCH_ALLOW_CLOCK"
ENV_INCIDENT = "ORCH_INCIDENT_ID"
ENV_TIMEOUT = "ORCH_HTTP_TIMEOUT_S"

DEFAULT_API_BASE = "http://localhost:8000"
DEFAULT_AGENT_NAME = "orchestrator"
DEFAULT_INCIDENT_ID = "camp-2018-drill"
# TODO(ADR 0030 "One active wildfire"): once the backend serves `GET /api/live/active`, default to
# the active incident instead of this constant, and re-read it when the console switches fires.
DEFAULT_TIMEOUT_S = 120.0
"""A twin-scored replan or a multi-set what-if can take tens of seconds."""

AGENT_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
"""Mirrors the backend's ``ACTOR_PATTERN`` (``agent:<name>``); a name outside it would be ignored."""


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class Config:
    api_base: str = DEFAULT_API_BASE
    token: str | None = field(default=None, repr=False)
    agent_name: str = DEFAULT_AGENT_NAME
    allow_clock: bool = False
    incident_id: str = DEFAULT_INCIDENT_ID
    timeout_s: float = DEFAULT_TIMEOUT_S

    @property
    def actor(self) -> str:
        return f"agent:{self.agent_name}"

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> Config:
        env = dict(os.environ if env is None else env)
        base = (env.get(ENV_API_BASE) or DEFAULT_API_BASE).strip().rstrip("/")
        if not base.startswith(("http://", "https://")):
            raise ConfigError(f"{ENV_API_BASE} must be an http(s) URL.")
        name = (env.get(ENV_AGENT_NAME) or DEFAULT_AGENT_NAME).strip()
        if not AGENT_NAME_PATTERN.match(name):
            raise ConfigError(f"{ENV_AGENT_NAME} must match {AGENT_NAME_PATTERN.pattern}.")
        try:
            timeout = float(env.get(ENV_TIMEOUT) or DEFAULT_TIMEOUT_S)
        except ValueError as exc:
            raise ConfigError(f"{ENV_TIMEOUT} must be a number of seconds.") from exc
        return cls(
            api_base=base,
            token=(env.get(ENV_TOKEN) or "").strip() or None,
            agent_name=name,
            allow_clock=(env.get(ENV_ALLOW_CLOCK) or "").strip() == "1",
            incident_id=(env.get(ENV_INCIDENT) or DEFAULT_INCIDENT_ID).strip(),
            timeout_s=timeout,
        )
