"""Load test for the live drill: many phones plus consoles against one running backend.

Each simulated phone does what the apps do (docs/live-reports.md "Polling"): ``POST devices``
(responders ``POST join``), then poll ``situation`` every 3 s (the first poll includes zones,
later polls use ``zones=0``), plus ``me/reports`` and ``me/tasks`` for responders; at low rates
it also submits reports, check-ins, destination choices and responder locations. Each console
polls ``command`` every 3 s and ``twin`` every 5 s. The phone count is ramped in stages; per
stage it prints p50/p95/p99 latency per endpoint, status counts, throughput and the server-side
snapshot age (the drill-clock lag), and ``--out`` gets the same as JSON.

Standard library only (threads + urllib). The test writes drill data. Every report carries the
note ``loadtest`` and every device is listed in a manifest file; ``--cleanup`` then deletes
those devices' reports, check-ins, destination choices, locations and the devices themselves
through the database (run it where the server's MONGODB_* variables are set).

Start the server under test with ``LIVE_LOADTEST_RELAX_LIMITS=1`` (off by default), otherwise
the per-IP and per-device rate limits answer 429 almost at once. See docs/live-loadtest.md.
"""

from __future__ import annotations

import json
import math
import os
import random
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import UTC, datetime
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from livecore.drill import INCIDENT_ID

LOADTEST_NOTE = "loadtest"
CORE = [-121.6012, 39.7593]  # Skyway in Paradise [lon, lat]
RESPONDER_FRACTION = 0.10
PHONE_POLL_S = 3.0
COMMAND_POLL_S = 3.0
TWIN_POLL_S = 5.0
# Per-poll probabilities for a phone's low-rate actions (a poll is every 3 s).
P_REPORT = 0.02  # about one report per 2.5 min per phone
P_CHECKIN = 0.04
P_DESTINATION = 0.03
P_LOCATION = 0.25  # responders: about every 12 s
REPORT_KINDS = ("road_blocked", "road_passable", "heavy_traffic", "fire_seen", "heavy_smoke")
COLLECTIONS_BY_PARTY = ("live_reports", "live_checkins", "live_destination_choices", "live_responder_locations")


# ---- pure stats (tested in api/tests/test_live_loadtest.py) ----


def percentile(values: list[float], p: float) -> float:
    """Linear-interpolated percentile (p in 0..100) of ``values``; 0.0 for an empty list."""
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return float(ordered[0])
    rank = (len(ordered) - 1) * (p / 100.0)
    lo, hi = math.floor(rank), math.ceil(rank)
    return float(ordered[lo] + (ordered[hi] - ordered[lo]) * (rank - lo))


def is_error(status: str) -> bool:
    """2xx and 3xx are fine; any 4xx/5xx and transport failures ("timeout", "error") count."""
    return not (status.isdigit() and int(status) < 400)


def summarize(samples: list[tuple[str, float]], seconds: float) -> dict:
    """``samples`` are (status, latency_ms); returns counts, percentiles, status mix and rates."""
    lat = [ms for _, ms in samples]
    statuses: dict[str, int] = {}
    for status, _ in samples:
        statuses[status] = statuses.get(status, 0) + 1
    errors = sum(n for s, n in statuses.items() if is_error(s))
    n = len(samples)
    return {
        "n": n,
        "rps": round(n / seconds, 2) if seconds > 0 else 0.0,
        "p50_ms": round(percentile(lat, 50), 1),
        "p95_ms": round(percentile(lat, 95), 1),
        "p99_ms": round(percentile(lat, 99), 1),
        "max_ms": round(max(lat), 1) if lat else 0.0,
        "status": dict(sorted(statuses.items())),
        "error_rate": round(errors / n, 4) if n else 0.0,
    }


def default_ramp(phones: int) -> list[int]:
    return sorted({max(1, round(phones * f)) for f in (0.05, 0.25, 0.5, 1.0)})


def parse_ramp(text: str) -> list[int]:
    try:
        stages = [int(part) for part in text.split(",") if part.strip()]
    except ValueError as exc:
        raise CommandError("--ramp must be comma-separated integers, e.g. 10,50,100,200") from exc
    if not stages or any(s < 1 for s in stages) or stages != sorted(stages):
        raise CommandError("--ramp needs ascending positive integers.")
    return stages


def should_stop(overall: dict, p95_limit_ms: float, error_limit: float) -> str | None:
    if overall["p95_ms"] > p95_limit_ms:
        return f"p95 {overall['p95_ms']:.0f} ms exceeds {p95_limit_ms:.0f} ms"
    if overall["error_rate"] > error_limit:
        return f"error rate {overall['error_rate']:.1%} exceeds {error_limit:.1%}"
    return None


# ---- load generator ----


class Recorder:
    """Thread-safe sample store keyed by the current stage."""

    def __init__(self):
        self.lock = threading.Lock()
        self.stage = 0
        self.samples: dict[int, dict[str, list[tuple[str, float]]]] = {}
        self.ages: dict[int, list[float]] = {}
        self.clock_errors: dict[int, list[float]] = {}
        self.device_keys: list[dict] = []

    def add(self, endpoint: str, status: str, ms: float) -> None:
        with self.lock:
            self.samples.setdefault(self.stage, {}).setdefault(endpoint, []).append((status, ms))

    def add_age(self, age_s: float) -> None:
        with self.lock:
            self.ages.setdefault(self.stage, []).append(age_s)

    def add_clock_error(self, err_s: float) -> None:
        with self.lock:
            self.clock_errors.setdefault(self.stage, []).append(err_s)

    def add_device(self, body: dict) -> None:
        with self.lock:
            self.device_keys.append({"party_key": body["party_key"], "role": body["role"]})


def endpoint_name(method: str, path: str) -> str:
    route, _, query = path.partition("?")
    parts = route.split("/")
    if parts[0] == "incidents" and len(parts) >= 3:
        parts = parts[2:]  # drop incidents/<id>
    return f"{method} {'/'.join(parts)}" + (f"?{query}" if query else "")


def parse_utc(text: str) -> float:
    return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(UTC).timestamp()


class Client:
    def __init__(self, base: str, recorder: Recorder, timeout: float = 20.0):
        self.base = base
        self.rec = recorder
        self.timeout = timeout

    def call(self, method: str, path: str, token: str | None = None, body: dict | None = None):
        """One request; records (endpoint, status, latency) and returns (status, parsed body, recv wall time)."""
        headers = {"Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        request = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        started = time.monotonic()
        payload = None
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
                status = str(response.status)
        except urllib.error.HTTPError as exc:
            raw, status = exc.read(), str(exc.code)
        except TimeoutError:
            raw, status = b"", "timeout"
        except (urllib.error.URLError, OSError):
            raw, status = b"", "error"
        ms = (time.monotonic() - started) * 1000
        received = time.time()
        if raw and status.isdigit() and int(status) < 300:
            try:
                payload = json.loads(raw)
            except ValueError:
                status = "badjson"
        self.rec.add(endpoint_name(method, path), status, ms)
        return status, payload, received


class Phone(threading.Thread):
    def __init__(self, client: Client, incident: str, invite: str | None, stop: threading.Event, seed: int):
        super().__init__(daemon=True)
        self.client, self.incident, self.invite, self.stop_event = client, incident, invite, stop
        self.rng = random.Random(seed)
        self.token: str | None = None
        self.zone: str | None = None
        self.offered: list[str] = []
        self.first = True

    def register(self) -> bool:
        if self.invite:
            status, body, _ = self.client.call("POST", f"incidents/{self.incident}/join", body={"invite_code": self.invite})
        else:
            status, body, _ = self.client.call("POST", "devices")
        if status != "201" or not body:
            return False
        self.token = body["token"]
        self.client.rec.add_device(body)
        return True

    def run(self) -> None:
        if not self.register():
            return
        # Spread the phones across the 3 s period like real clients that started at different times.
        if self.stop_event.wait(self.rng.uniform(0, PHONE_POLL_S)):
            return
        next_poll = time.monotonic()
        while not self.stop_event.is_set():
            self.poll()
            next_poll += PHONE_POLL_S
            if self.stop_event.wait(max(0.0, next_poll - time.monotonic())):
                return

    def poll(self) -> None:
        inc = self.incident
        zones = "" if self.first else "?zones=0"
        _, sit, received = self.client.call("GET", f"incidents/{inc}/situation{zones}", self.token)
        if sit:
            self.client.rec.add_age(max(0.0, received - parse_utc(sit["generated_at"])))
            guidance = sit.get("guidance") or []
            if guidance:
                g = guidance[0]
                self.zone = g["zone_id"]
                self.offered = [a["destination"]["id"] for a in g.get("alternatives") or []] or [g["destination"]["id"]]
        self.first = False
        responder = self.invite is not None
        if responder:
            self.client.call("GET", "me/reports", self.token)
            self.client.call("GET", "me/tasks", self.token)
            if self.rng.random() < P_LOCATION:
                coord = [CORE[0] + self.rng.uniform(-0.02, 0.02), CORE[1] + self.rng.uniform(-0.02, 0.02)]
                self.client.call("POST", "me/location", self.token, {"coord": coord, "accuracy_m": 8})
        if self.rng.random() < P_REPORT:
            self.client.call("POST", f"incidents/{inc}/reports", self.token, {
                "client_id": str(uuid.uuid4()),
                "kind": self.rng.choice(REPORT_KINDS),
                "severity": "partial",
                "location": {"coord": [CORE[0] + self.rng.uniform(-0.01, 0.01), CORE[1] + self.rng.uniform(-0.01, 0.01)],
                             "accuracy_m": 10},
                "observed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "note": LOADTEST_NOTE,
            })
        if self.zone and self.rng.random() < P_CHECKIN:
            self.client.call("POST", f"incidents/{inc}/checkins", self.token,
                             {"status": self.rng.choice(["out", "staying"]), "zone_id": self.zone})
        if self.zone and self.offered and not responder and self.rng.random() < P_DESTINATION:
            self.client.call("POST", "me/destination", self.token,
                             {"zone_id": self.zone, "destination_id": self.rng.choice(self.offered)})


class Console(threading.Thread):
    """The web console: command every 3 s, twin every 5 s."""

    def __init__(self, client: Client, incident: str, controller: str | None, stop: threading.Event, offset: float):
        super().__init__(daemon=True)
        self.client, self.incident, self.controller, self.stop_event, self.offset = client, incident, controller, stop, offset

    def run(self) -> None:
        if self.stop_event.wait(self.offset):
            return
        next_command = next_twin = time.monotonic()
        while not self.stop_event.is_set():
            now = time.monotonic()
            if now >= next_command:
                _, body, received = self.client.call("GET", f"incidents/{self.incident}/command", self.controller)
                if body:
                    self.client.rec.add_age(max(0.0, received - parse_utc(body["generated_at"])))
                    drill = body["drill"]
                    if drill.get("running") and drill.get("started_at"):
                        expected = parse_utc(drill["replay_start"]) + (
                            parse_utc(body["generated_at"]) - parse_utc(drill["started_at"])) * drill["speed"]
                        self.client.rec.add_clock_error(abs(expected - parse_utc(drill["replay_now"])))
                next_command += COMMAND_POLL_S
            if now >= next_twin:
                self.client.call("GET", f"incidents/{self.incident}/twin", self.controller)
                next_twin += TWIN_POLL_S
            wait = min(next_command, next_twin) - time.monotonic()
            if self.stop_event.wait(max(0.0, wait)):
                return


# ---- command ----


class Command(BaseCommand):
    help = "Load-test the live drill with simulated phones and consoles; --cleanup removes the test data."

    def add_arguments(self, parser):
        parser.add_argument("--base", default="http://127.0.0.1:8000", help="Server origin under test.")
        parser.add_argument("--incident", default=INCIDENT_ID)
        parser.add_argument("--invite", default=os.environ.get("LIVE_INVITE_CODE", ""), help="Responder invite code.")
        parser.add_argument("--phones", type=int, default=200, help="Peak simulated phones (the last stage).")
        parser.add_argument("--consoles", type=int, default=2, help="Simulated web consoles.")
        parser.add_argument("--duration", type=float, default=30.0, help="Seconds per stage.")
        parser.add_argument("--ramp", help="Comma-separated phone counts per stage (overrides --phones); "
                                           "default is 5/25/50/100%% of --phones.")
        parser.add_argument("--responders", type=float, default=RESPONDER_FRACTION,
                            help="Fraction of phones that are responders.")
        parser.add_argument("--p95-limit-ms", type=float, default=2000.0, help="Stop ramping when overall p95 exceeds this.")
        parser.add_argument("--error-limit", type=float, default=0.01, help="Stop ramping when the error rate exceeds this.")
        parser.add_argument("--out", help="Write the full results as JSON to this path.")
        parser.add_argument("--manifest", help="Where to list the devices this run created (for --cleanup).")
        parser.add_argument("--cleanup", action="store_true", help="Delete loadtest data through the database, then exit.")

    def handle(self, *args, **options):
        if options["manifest"]:
            manifest = Path(options["manifest"])
        elif options["out"]:
            manifest = Path(options["out"]).with_suffix(".devices.json")
        else:
            manifest = Path(tempfile.gettempdir()) / "crisistwin-loadtest-devices.json"
        if options["cleanup"]:
            return self.cleanup(manifest, options["incident"])
        invite = options["invite"]
        if not invite:
            raise CommandError("Pass --invite or set LIVE_INVITE_CODE (same value as the server).")
        ramp = parse_ramp(options["ramp"]) if options["ramp"] else default_ramp(options["phones"])
        base = options["base"].rstrip("/") + "/api/live/"
        inc = options["incident"]
        controller = os.environ.get("LIVE_CONTROLLER_TOKEN") or None
        rec = Recorder()
        client = Client(base, rec)

        self.prepare(client, inc, controller)
        results = {
            "config": {"base": options["base"], "ramp": ramp, "consoles": options["consoles"],
                       "duration_s": options["duration"], "responder_fraction": options["responders"],
                       "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
            "stages": [], "stopped_reason": None,
        }
        stops: list[threading.Event] = []
        phones: list[Phone] = []
        consoles: list[Console] = []
        stop_consoles = threading.Event()
        every = max(1, round(1 / options["responders"])) if options["responders"] > 0 else 0
        try:
            rec.stage = 1
            for i in range(options["consoles"]):
                consoles.append(Console(client, inc, controller, stop_consoles, i * COMMAND_POLL_S / options["consoles"]))
            for c in consoles:
                c.start()
            for index, count in enumerate(ramp, start=1):
                rec.stage = index
                while len(phones) < count:
                    n = len(phones)
                    stop = threading.Event()
                    stops.append(stop)
                    phone = Phone(client, inc, invite if every and n % every == 0 else None, stop, seed=n)
                    phones.append(phone)
                    phone.start()
                    time.sleep(0.01)  # do not start the whole fleet in one instant
                started = time.monotonic()
                time.sleep(options["duration"])
                seconds = time.monotonic() - started
                stage = self.stage_result(rec, index, count, options["consoles"], seconds)
                results["stages"].append(stage)
                self.print_stage(stage)
                reason = should_stop(stage["overall"], options["p95_limit_ms"], options["error_limit"])
                if reason:
                    results["stopped_reason"] = f"stage {index} ({count} phones): {reason}"
                    self.stdout.write(self.style.WARNING("stopping the ramp: " + results["stopped_reason"]))
                    break
        finally:
            stop_consoles.set()
            for s in stops:
                s.set()
            for t in phones + consoles:
                t.join(timeout=25)
            manifest.write_text(json.dumps({"incident": inc, "devices": rec.device_keys}, indent=1))
            self.stdout.write(f"{len(rec.device_keys)} devices listed in {manifest}; remove the data with "
                              f"`manage.py live_loadtest --cleanup --manifest {manifest}`")
        if options["out"]:
            Path(options["out"]).write_text(json.dumps(results, indent=1))
            self.stdout.write(f"results written to {options['out']}")
        self.print_summary(results)

    def prepare(self, client: Client, inc: str, controller: str | None) -> None:
        """Check the server is up and the drill has guidance to choose destinations from."""
        status, body, _ = client.call("POST", "devices")
        if status != "201":
            raise CommandError(
                f"POST devices returned {status}. Is the server up at {client.base}, and started with "
                "LIVE_LOADTEST_RELAX_LIMITS=1?")
        client.rec.add_device(body)
        _, sit, _ = client.call("GET", f"incidents/{inc}/situation?zones=0", body["token"])
        if sit and not sit["drill"]["running"]:
            raise CommandError("The drill is not running; run `live_drill --reset` against the server's database first.")
        if sit and not sit.get("guidance") and controller:
            client.call("POST", f"incidents/{inc}/replan", controller, {})
            _, cmd, _ = client.call("GET", f"incidents/{inc}/command", controller)
            for proposal in (cmd or {}).get("proposals", []):
                if proposal["status"] == "pending":
                    client.call("POST", f"proposals/{proposal['id']}/approve", controller, {})
        for _ in range(30):  # the twin builds in the background after a server start (503 twin_warming)
            status, _, _ = client.call("GET", f"incidents/{inc}/twin", controller)
            if status != "503":
                break
            time.sleep(3)
        client.rec.samples.clear()  # setup traffic is not part of any stage
        client.rec.ages.clear()

    def stage_result(self, rec: Recorder, index: int, phones: int, consoles: int, seconds: float) -> dict:
        with rec.lock:
            by_endpoint = {k: list(v) for k, v in rec.samples.get(index, {}).items()}
            ages = list(rec.ages.get(index, []))
            clock_errors = list(rec.clock_errors.get(index, []))
        everything = [s for v in by_endpoint.values() for s in v]
        return {
            "stage": index, "phones": phones, "consoles": consoles, "seconds": round(seconds, 1),
            "overall": summarize(everything, seconds),
            "endpoints": {k: summarize(v, seconds) for k, v in sorted(by_endpoint.items())},
            "snapshot_age_s": {"p50": round(percentile(ages, 50), 3), "p95": round(percentile(ages, 95), 3),
                               "max": round(max(ages), 3) if ages else 0.0},
            "drill_clock_error_s": {"p95": round(percentile(clock_errors, 95), 3),
                                    "max": round(max(clock_errors), 3) if clock_errors else 0.0},
        }

    def print_stage(self, stage: dict) -> None:
        o = stage["overall"]
        self.stdout.write(f"\nstage {stage['stage']}: {stage['phones']} phones + {stage['consoles']} consoles, "
                          f"{stage['seconds']} s, {o['n']} requests, {o['rps']} req/s")
        self.stdout.write(f"  {'endpoint':34} {'n':>6} {'rps':>6} {'p50':>7} {'p95':>7} {'p99':>7} {'err%':>6}  status")
        for name, s in {**stage["endpoints"], "ALL": o}.items():
            mix = " ".join(f"{k}:{v}" for k, v in s["status"].items())
            self.stdout.write(f"  {name:34} {s['n']:6d} {s['rps']:6.1f} {s['p50_ms']:7.0f} {s['p95_ms']:7.0f} "
                              f"{s['p99_ms']:7.0f} {s['error_rate'] * 100:6.2f}  {mix}")
        a, c = stage["snapshot_age_s"], stage["drill_clock_error_s"]
        self.stdout.write(f"  snapshot age on arrival (s): p50 {a['p50']}, p95 {a['p95']}, max {a['max']}; "
                          f"drill clock error (s): p95 {c['p95']}, max {c['max']}")

    def print_summary(self, results: dict) -> None:
        self.stdout.write("\nsummary (ms; ALL = every request)")
        self.stdout.write(f"  {'phones':>6} {'req/s':>7} {'p50':>7} {'p95':>7} {'p99':>7} {'err%':>6} {'age p95 s':>9}")
        for s in results["stages"]:
            o = s["overall"]
            self.stdout.write(f"  {s['phones']:6d} {o['rps']:7.1f} {o['p50_ms']:7.0f} {o['p95_ms']:7.0f} "
                              f"{o['p99_ms']:7.0f} {o['error_rate'] * 100:6.2f} {s['snapshot_age_s']['p95']:9.3f}")
        if results["stopped_reason"]:
            self.stdout.write(f"stopped: {results['stopped_reason']}")

    def cleanup(self, manifest: Path, inc: str) -> None:
        from api.live.common import col

        keys: set[str] = set()
        if manifest.exists():
            keys.update(d["party_key"] for d in json.loads(manifest.read_text()).get("devices", []))
        # Reports are tagged by note, so they are found even without the manifest.
        for doc in col("live_reports").find({"note": LOADTEST_NOTE, "incident_id": inc}, {"reporter.party_key": 1}):
            keys.add(doc["reporter"]["party_key"])
        if not keys:
            self.stdout.write("nothing to clean up")
            return
        listed = sorted(keys)
        removed = {}
        for name in COLLECTIONS_BY_PARTY:
            field = "reporter.party_key" if name == "live_reports" else "party_key"
            removed[name] = col(name).delete_many({field: {"$in": listed}}).deleted_count
        removed["live_devices"] = col("live_devices").delete_many({"party_key": {"$in": listed}}).deleted_count
        self.stdout.write("removed " + ", ".join(f"{n} {k}" for k, n in removed.items()))
        self.stdout.write("Run `live_drill --reset` to also clear guidance, proposals and decisions made during the test.")
