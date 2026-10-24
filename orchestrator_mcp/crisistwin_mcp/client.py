"""HTTP client for the CrisisTwin live controller API (docs/live-reports.md).

Standard library only. The transport is injectable so the tools can be tested against a fake
backend without a network. Every write sends ``X-CrisisTwin-Actor: agent:<name>`` so the backend
records the agent, not "controller", in ``live_decisions``.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from typing import Any

from .config import Config

ACTOR_HEADER = "X-CrisisTwin-Actor"
API_PREFIX = "/api/live/"
COMMAND_CACHE_S = 3.0
"""``command`` is several MB; tools that read it within this many seconds share one fetch."""

Transport = Callable[[str, str, dict[str, str], bytes | None, float], tuple[int, bytes]]
"""(method, url, headers, body, timeout_s) -> (status, response body)."""


class BackendError(Exception):
    """A non-2xx answer (or no answer) from the backend, with its ``{error, detail}`` body."""

    def __init__(self, status: int, code: str, detail: str = "", body: Any = None) -> None:
        super().__init__(f"{status} {code}: {detail}".strip())
        self.status = status
        self.code = code
        self.detail = detail
        self.body = body

    def as_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"error": self.code, "status": self.status}
        if self.detail:
            out["detail"] = self.detail
        if isinstance(self.body, dict):
            out.update({k: v for k, v in self.body.items() if k not in ("error", "detail") and v is not None})
        return out


def urllib_transport(method: str, url: str, headers: dict[str, str], body: bytes | None,
                     timeout: float) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - configured base URL
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        raise BackendError(0, "backend_unreachable", f"Cannot reach the CrisisTwin backend: {reason}") from None


class CrisisTwinClient:
    def __init__(self, config: Config, transport: Transport | None = None) -> None:
        self.config = config
        self.transport = transport or urllib_transport
        self._command_cache: dict[str, tuple[float, dict[str, Any]]] = {}

    def __repr__(self) -> str:  # never show the token
        return f"CrisisTwinClient(api_base={self.config.api_base!r}, actor={self.config.actor!r})"

    def _headers(self, write: bool) -> dict[str, str]:
        headers = {"Accept": "application/json"}
        if self.config.token:
            headers["Authorization"] = f"Bearer {self.config.token}"
        if write:
            headers[ACTOR_HEADER] = self.config.actor
        return headers

    def request(self, method: str, path: str, *, query: dict[str, Any] | None = None,
                body: dict[str, Any] | None = None, write: bool = False) -> Any:
        url = self.config.api_base + API_PREFIX + path.lstrip("/")
        if query:
            url += "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
        headers = self._headers(write)
        data = None
        if method != "GET":
            data = json.dumps(body or {}).encode()
            headers["Content-Type"] = "application/json"
        status, raw = self.transport(method, url, headers, data, self.config.timeout_s)
        try:
            parsed = json.loads(raw) if raw else None
        except ValueError:
            parsed = None
        if not 200 <= status < 300:
            payload = parsed if isinstance(parsed, dict) else {}
            code = str(payload.get("error") or f"http_{status}")
            detail = str(payload.get("detail") or "")
            if status == 404 and not payload:
                detail = f"No such endpoint on this backend (an older version?): {path}"
            raise BackendError(status, code, detail, payload)
        if write:
            self._command_cache.clear()
        return parsed

    def get(self, path: str, **query: Any) -> Any:
        return self.request("GET", path, query=query or None)

    def post(self, path: str, body: dict[str, Any] | None = None, *, write: bool = True) -> Any:
        """``write=False`` for POSTs that change nothing (impact, twin what-if): no actor header."""
        return self.request("POST", path, body=body, write=write)

    def command(self, incident_id: str) -> dict[str, Any]:
        cached = self._command_cache.get(incident_id)
        if cached and time.monotonic() - cached[0] < COMMAND_CACHE_S:
            return cached[1]
        data = self.get(f"incidents/{incident_id}/command")
        self._command_cache[incident_id] = (time.monotonic(), data)
        return data
