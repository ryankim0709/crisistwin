"""apify-client wrapper for the incident-intel Actor (docs/incident-intel.md (a), (c)).

`apify_client` is imported lazily so the backend runs without it: offline ingest, review and
the candidate list never touch Apify. APIFY_TOKEN and APIFY_ACTOR_ID are read from the server
environment only and never appear in exceptions, responses or logs.
"""

import os
from typing import Any

SET_APIFY_HELP = (
    "Set APIFY_TOKEN and APIFY_ACTOR_ID in the shell that runs Django (or app/.env for Docker "
    "Compose) and restart the backend. Uploading Actor output with `items` works without them."
)
LATEST_RUN_SCAN = 20  # newest SUCCEEDED runs searched for one in the requested mode


class ApifyUnavailable(Exception):
    """Apify is not configured (token/Actor id unset) or apify-client is not installed."""


class ApifyError(Exception):
    """Apify answered with an error or could not be reached. Messages never include the token."""


class RunNotFound(ApifyError):
    pass


class RunNotFinished(Exception):
    def __init__(self, status: str):
        super().__init__(status)
        self.status = status


def _settings() -> tuple[str, str]:
    token = os.environ.get("APIFY_TOKEN", "").strip()
    actor_id = os.environ.get("APIFY_ACTOR_ID", "").strip()
    if not token or not actor_id:
        raise ApifyUnavailable(f"Apify is not configured on the server. {SET_APIFY_HELP}")
    return token, actor_id


def _client():
    token, actor_id = _settings()
    try:
        from apify_client import ApifyClient
    except ImportError as exc:
        raise ApifyUnavailable(
            "The apify-client package is not installed on the server (see app/backend/requirements.txt)."
        ) from exc
    return ApifyClient(token), actor_id


def _upstream(exc: Exception) -> ApifyError:
    # Only the class name and HTTP status: provider messages can echo request details.
    status = getattr(exc, "status_code", None)
    suffix = f" (HTTP {status})" if status else ""
    return ApifyError(f"Apify request failed: {type(exc).__name__}{suffix}.")


def _value(value: Any) -> Any:
    return getattr(value, "value", value)


def _utc(value: Any) -> str | None:
    if value is None:
        return None
    if hasattr(value, "strftime"):
        return value.strftime("%Y-%m-%dT%H:%M:%SZ")
    return str(value)


def start_run(run_input: dict) -> dict:
    """Start the Actor; return {run_id, dataset_id, status, started_at} without waiting."""
    client, actor_id = _client()
    try:
        run = client.actor(actor_id).start(run_input=run_input)
    except Exception as exc:  # apify-client and its HTTP layer raise several unrelated types
        raise _upstream(exc) from exc
    return {
        "run_id": run.id,
        "dataset_id": run.default_dataset_id,
        "status": str(_value(run.status)),
        "started_at": _utc(run.started_at),
    }


def latest_succeeded_run(mode: str = "live") -> dict | None:
    """{run_id, dataset_id, finished_at} of the Actor's newest SUCCEEDED run in `mode`, or None.

    Runs do not expose their input mode, so the first dataset item's `mode` decides; runs with
    an empty dataset are skipped. Only the newest LATEST_RUN_SCAN runs are checked.
    """
    client, actor_id = _client()
    try:
        runs = client.actor(actor_id).runs().list(limit=LATEST_RUN_SCAN, desc=True, status="SUCCEEDED").items
        for run in runs:
            first = client.dataset(run.default_dataset_id).list_items(limit=1, fields=["mode"]).items
            if first and first[0].get("mode") == mode:
                return {
                    "run_id": run.id,
                    "dataset_id": run.default_dataset_id,
                    "finished_at": _utc(run.finished_at),
                }
    except Exception as exc:
        raise _upstream(exc) from exc
    return None


def run_dataset(run_id: str) -> str:
    """The default dataset id of a SUCCEEDED run; RunNotFinished otherwise."""
    client, _ = _client()
    try:
        run = client.run(run_id).get()
    except Exception as exc:
        raise _upstream(exc) from exc
    if run is None:
        raise RunNotFound("Apify run not found.")
    status = str(_value(run.status))
    if status != "SUCCEEDED":
        raise RunNotFinished(status)
    return run.default_dataset_id


def dataset_items(dataset_id: str, limit: int = 200) -> list[dict]:
    """Up to `limit` dataset items (clean: no hidden fields), in insertion order."""
    client, _ = _client()
    try:
        page = client.dataset(dataset_id).list_items(limit=limit, clean=True)
    except Exception as exc:
        raise _upstream(exc) from exc
    return list(page.items)
