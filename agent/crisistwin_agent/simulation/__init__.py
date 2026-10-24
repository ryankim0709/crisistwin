"""Fire-spread adapters.

The only model CrisisTwin runs is the TypeScript Rothermel/minimum-travel-time model in
``app/src/fire/``. :class:`NodeFireBridge` drives it from Python through the Node sidecar
in ``agent/bridge/``; there is deliberately no Python reimplementation of the physics.
"""

from __future__ import annotations

from .bridge import (
    DEFAULT_BRIDGE_SCRIPT,
    METERS_PER_FOOT,
    MODEL_LIMITATIONS,
    NodeFireBridge,
    radius_for_horizon,
)

__all__ = [
    "DEFAULT_BRIDGE_SCRIPT",
    "METERS_PER_FOOT",
    "MODEL_LIMITATIONS",
    "NodeFireBridge",
    "radius_for_horizon",
]
