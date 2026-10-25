"""TypeSafe Jev adapter: typed, probabilistic decisions (``POST /v1/systemone``).

Pure transport, stdlib ``urllib`` only, like ``cartesia``. Jev answers bounded questions (choice,
score, noul) with calibrated probabilities instead of prose; the caller decides what to do with
them. The key stays server-side (``TYPESAFE_API_KEY``). Paid usage (input tokens only).
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

API_URL = "https://api.typesafe.ai/v1/systemone"
DEFAULT_MODEL = "jev-latest"
HTTP_TIMEOUT_S = 4.0
"""Jev answers in about 0.1-0.5 s; past this the voice turn falls back to Claude."""


class JevError(Exception):
    """A Jev call failed. ``code`` is ``unconfigured``, ``rejected``, ``upstream`` or ``unreachable``."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


def api_key() -> str:
    return os.environ.get("TYPESAFE_API_KEY", "").strip()


def is_configured() -> bool:
    return bool(api_key())


def model() -> str:
    return os.environ.get("JEV_MODEL", "").strip() or DEFAULT_MODEL


def choice(instructions: str, criteria: dict[str, str | None]) -> dict[str, Any]:
    return {"type": "choice", "instructions": instructions, "criteria": criteria}


def noul(instructions: str) -> dict[str, Any]:
    return {"type": "noul", "instructions": instructions}


def system_one(state: Any, questions: dict[str, dict[str, Any]]) -> tuple[dict[str, dict[str, Any]], str]:
    """(answers by question id, model id). Each choice answer has ``choice``, ``probabilities``
    and ``confidence``; a noul answer has ``noul`` (the probability of yes)."""
    key = api_key()
    if not key:
        raise JevError("unconfigured", "Set TYPESAFE_API_KEY in the shell that runs Django and restart it.")
    body = json.dumps({"model": model(), "state": state, "questions": questions}).encode()
    request = urllib.request.Request(
        API_URL,
        data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_S) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise JevError("unconfigured", "TypeSafe rejected the API key.") from exc
        if exc.code in (400, 422):
            raise JevError("rejected", f"TypeSafe did not accept the request (HTTP {exc.code}).") from exc
        raise JevError("upstream", f"TypeSafe returned HTTP {exc.code}.") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise JevError("unreachable", "Could not reach TypeSafe.") from exc
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise JevError("upstream", "TypeSafe sent an unreadable answer.") from exc
    answers = data.get("answers") if isinstance(data, dict) else None
    if not isinstance(answers, dict):
        raise JevError("upstream", "TypeSafe sent no answers.")
    return answers, str(data.get("model") or model())
