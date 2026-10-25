# Live drill load test

Question: can one hosted backend serve many phones plus the console? The tool is
`python manage.py live_loadtest` (`app/backend/api/management/commands/live_loadtest.py`,
standard library only). This page is the method, the measured results, the bottlenecks and
what to do next. The numbers come from one laptop, so read them as relative, not as capacity
planning for a host (see Caveats).

## Method

Simulated clients follow [Polling](live-reports.md#polling) and the apps' behaviour:

- **Phone** (90 % civilian, 10 % responder through the invite code): `POST devices` (or
  `POST incidents/{id}/join`), then every 3 s `GET situation` (the first poll includes zones,
  later ones use `zones=0`). Responders also poll `me/reports` and `me/tasks`. Per 3 s poll a
  phone has a 2 % chance of submitting a report (note `loadtest`), 4 % of a check-in, 3 % of a
  destination choice (civilians), and responders send `me/location` with 25 %.
- **Console**: `GET command` every 3 s and `GET twin` every 5 s.
- **Ramp**: the phone count rises in stages (phones stay on), each stage lasts `--duration`
  seconds, consoles stay constant. The ramp stops after the first stage whose overall p95 is
  above `--p95-limit-ms` (2000) or whose error rate is above `--error-limit` (1 %).
  Transport failures and timeouts count as errors, 429 too.
- **Output**: a table per stage (n, req/s, p50/p95/p99 and error share per endpoint, status
  mix), a summary, and with `--out` the same as JSON. "Snapshot age" is the client receive
  time minus the server's `generated_at`; "drill clock error" is the server's `replay_now`
  minus the value expected from the drill document at `generated_at`. Both have **1 s
  resolution** because the API serializes times to whole seconds, so an age under about 1 s
  and a clock error of 0-1 s mean "no measurable lag". Neither grew with load; the clock is
  derived from wall time per request, so it cannot drift, it can only be served late.
- **Tagging and cleanup**: every report carries the note `loadtest`, and each run writes a
  manifest of the device party keys it created (`--out` path with `.devices.json`, or
  `--manifest`). `python manage.py live_loadtest --cleanup [--manifest FILE]`, with the
  server's `MONGODB_*` set, deletes those devices and their reports, check-ins, destination
  choices and responder locations through the database; reports are also found by note, so
  cleanup works without the manifest. Guidance, proposals and decisions made during the run
  are cleared with `live_drill --reset`.
- **Rate limits** ([auth.py](../app/backend/api/live/auth.py)): `devices` and `join` allow 20
  per hour per IP, and reports, check-ins and destination choices are limited per device and
  IP, so any single-host test gets 429s at once. `LIVE_LOADTEST_RELAX_LIMITS=1` (settings env,
  default off) makes `rate_limited` always return False. Start only the server under test with
  it; never set it on a shared or hosted deployment. The test itself never sends it.

### Reproduce

```sh
cd app/backend && source .venv/bin/activate
export MONGODB_URI=mongodb://127.0.0.1:27017 MONGODB_DATABASE=crisistwin_load_test \
  LIVE_CONTROLLER_TOKEN=dev-controller LIVE_INVITE_CODE=DRILL LIVE_LOADTEST_RELAX_LIMITS=1 \
  LIVE_DRILL_BUNDLE=/abs/path/app/public/replays/camp-2018.json   # CRISISTWIN_REPO_ROOT if the twin data is elsewhere
python manage.py live_init_db && python manage.py live_drill --reset
python manage.py runserver 127.0.0.1:8020 --noreload &            # or the gunicorn line below
python manage.py live_loadtest --base http://127.0.0.1:8020 --ramp 10,50,100,200,300,400 \
  --duration 30 --consoles 3 --out results.json
python manage.py live_loadtest --cleanup --manifest results.devices.json
```

The command waits for the twin to finish warming (503 `twin_warming`, 10-60 s after a start)
before the first stage, and approves a pending proposal when the drill has no guidance yet.

## Results

Setup: macOS laptop (the load generator, MongoDB and the server share it), local MongoDB,
Django `DEBUG` on, 3 consoles, 30 s per stage, a fresh drill (`live_drill --reset`) per run.
Latency is for **all requests** in the stage. Error % is non-2xx plus transport failures.

### Before: `runserver`, no optimisation

| Phones | Req/s | p50 ms | p95 ms | p99 ms | Errors | `situation?zones=0` p95 ms |
|---:|---:|---:|---:|---:|---:|---:|
| 10 | 6.4 | 22 | 119 | 169 | 0 % | 112 |
| 50 | 24.7 | 25 | 124 | 183 | 0 % | 118 |
| 100 | 47.9 | 65 | 232 | 447 | 0 % | 207 |
| 200 | 55.9 | 1365 | **7773** | 7850 | **5.0 %** | 7773 |

Stopped at 200 phones. Throughput plateaus near 56 req/s and the queue builds from there;
the demanded rate at 200 phones is about 96 req/s. Only 100 phones fit one `runserver`.

### After: `runserver`, with the render fast path and guidance cache

| Phones | Req/s | p50 ms | p95 ms | p99 ms | Errors | `situation?zones=0` p95 ms |
|---:|---:|---:|---:|---:|---:|---:|
| 10 | 6.4 | 12 | 95 | 144 | 0 % | 19 |
| 50 | 24.7 | 11 | 71 | 138 | 0 % | 52 |
| 100 | 48.0 | 11 | 57 | 119 | 0 % | 36 |
| 200 | 96.0 | 17 | 322 | 580 | 0 % | 325 |
| 300 | 139.2 | 123 | 456 | 4077 | 0.4 % | 434 |
| 400 | 138.8 | 288 | **7774** | 7778 | **11.9 %** | 7774 |

Stopped at 400. One `runserver` now carries about 200 phones plus 3 consoles inside the 2 s
and 1 % limits (about 2x the phones before; throughput ceiling 56 to about 140 req/s).

### Alternative: `gunicorn --workers 4 --threads 4` (already in requirements)

After the same optimisations, ramp 100 to 400:

| Phones | Req/s | p50 ms | p95 ms | p99 ms | Errors |
|---:|---:|---:|---:|---:|---:|
| 100 | 49.7 | 11 | 48 | 124 | 0.07 % (one 503 at start) |
| 200 | 95.5 | 12 | 36 | 75 | 0 % |
| 300 | 140.1 | 13 | 41 | 77 | 0 % |
| 400 | 190.1 | 23 | 1153 | 2581 | 0 % |

400 phones still pass the 2 s and 1 % limits at the whole-run level (p95 1.15 s) but the knee
is visible (`command` p95 2.1 s). The Python load generator was itself near one core at about
190 req/s, so the true server knee is somewhat higher. Each worker has its own twin copy and
its own guidance and rate-limit cache; MongoDB is shared.

`runserver` is not a production server (single process per instance, no worker management,
DEBUG error pages); it is used here only because the task asked for a throwaway local backend.
Use gunicorn for any hosted drill ([Dockerfile](../app/backend/Dockerfile)).

## Bottlenecks

Profile of one handler with `cProfile` through the Django test client (50 calls, local
MongoDB, about 70-195 reports in the drill):

**`situation?zones=0`** (the hot path: every phone every 3 s), 22.2 ms per request before.
Response is **112 KB even with `zones=0`**, nearly all of it `guidance` (routes and
alternatives):

| Cost (before) | Share | Where |
|---|---:|---|
| `state.render` on guidance documents (668 k recursive calls, `isinstance` against `Mapping` ABC) | about 45-55 % | `guidance_json` in `api/live/state.py` |
| MongoDB round trips and BSON decode (guidance aggregate, device, drill, reports, check-in) | about 25-30 % | PyMongo |
| JSON encoding of the 112 KB body | about 8 % | DRF `JSONRenderer` |
| Public snapshot rebuild per request: `estimate_fire`, `independent_counts`, `report_fact`, `road_state`, haversine | about 10 % and growing with the report count | `load_snapshot` |

After the render fast path and the guidance cache the request costs about 13 ms: the
remaining cost is MongoDB round trips (about 6 ms), the JSON encoding (2.5 ms) and the
per-request snapshot rebuild (about 4 ms). At about 13 ms per request one process saturates
near 75-140 req/s, which matches the ramp.

**`command`** (3 consoles, 1 req/s in total): **310 ms and 1.3 MB per request** once the drill
holds about 200 reports. Sizes by key: `zones` 905 KB (static for the whole drill),
`proposals` 226 KB, `reports` 125 KB, `guidance` 113 KB. It is only one request every 3 s per
console, but each console costs about 10 % of a core and 3.4 Mbit/s, and a slow `command`
holds a worker. This is the next bottleneck and the reason `command` p95 jumps first at the
knee.

**Other findings**

- `situation` also runs `maybe_auto_replan` on read; it did not show in the profile at this
  report count, but the `load_snapshot` work grows with the number of reports (capped by
  `REPORTS_SNAPSHOT_LIMIT`).
- The first poll with `zones` is 4-8x slower than `zones=0` (p95 200-500 ms) but happens once
  per phone launch.
- `twin` is cheap after warm-up (p50 25-60 ms) but returns 503 `twin_warming` for 10-60 s after
  a process start; with gunicorn, that happens once per worker, so deploy with a warm-up
  request per worker before opening to phones.
- Failures at overload are connection errors after about 7.7 s, not 5xx: the accept queue of
  the dev server overflows. A reverse proxy with a short timeout and `Retry-After` is better.
- Responses carry no compression, `ETag` or `Cache-Control`.

## Optimisations made

Both are contained and covered by `api/tests/test_live_loadtest.py`.

1. **Faster `state.render`** (`api/live/state.py`): exact-type checks (`type(v) is float`, `dict`,
   `list`, `datetime`) before the ABC `isinstance` fallback. Output is identical (test pins the
   conversion). `situation` 22.2 to 17.6 ms.
2. **Guidance cache** (`rendered_guidance` in `api/live/state.py`): the rendered guidance list
   (and, since 2026-10-25, the `current_guidance` aggregate behind it, which a `twin` poll read three
   times) is kept per process for `LIVE_GUIDANCE_CACHE_TTL_S` (default 1 s; 0 disables). Writers in
   the process (`controller.publish`, the safety re-annotation, `drill reset`) call
   `invalidate_guidance`, so a controller's approval is visible to the next poll on the same
   process; other processes see it within 1 s, well inside the 3 s poll. `situation` 17.6 to
   about 13 ms; ceiling at the 2 s limit goes from 100 to about 200 phones on `runserver`. The 3 s
   phone poll cannot observe a 1 s stale guidance by more than one poll cycle.

The rest of the existing backend suite passed (109 tests) with both changes.

## Recommendations

In rough order of value per effort:

1. **`command`: send zones once.** Add `?zones=0` (as `situation` has) and have the console
   request zones on load and on a `zones_version` change only. Saves 905 KB of 1.3 MB and most
   of the 310 ms. Also cap or paginate `proposals`, which keeps resolved ones.
2. **Cache the public snapshot per drill tick.** `load_snapshot` (reports query, `report_fact`,
   public items, road state, fire estimate) is recomputed per request but only changes when a
   report is written or the drill clock moves a second. Cache it per process keyed by
   `(drill clock second, report write counter or max updated_at)`, with a 1 s TTL, and
   `situation` becomes about two MongoDB round trips (device lookup and own check-in). This
   is the next 30-40 % of `situation`.
3. **Cache the device lookup** in `authenticate` (token hash to principal) for 30-60 s;
   it is one MongoDB query per request and the document only changes on expiry.
4. **ETag or `If-None-Match` on `situation` and `command`**, from a hash of the rendered
   body or of the cache keys above. Phones on cellular save the 112 KB when nothing changed
   (the guidance changes rarely); a 304 skips JSON encoding too.
5. **gzip at the edge** (nginx `gzip on`, or Cloudflare). The JSON is highly repetitive
   (coordinates), so it should shrink several-fold (not measured). Do it at the proxy, not in Django, so
   workers are not spending CPU on it.
6. **Run gunicorn** with several workers (4 workers x 4 threads held 300 phones at p95 41 ms
   on this laptop), `DJANGO_DEBUG=false`, a warm-up request to `twin` per worker, and a
   shared rate-limit store (the default `LocMemCache` is per process, so limits are
   per-worker; use Redis or the database cache before relying on them behind several workers).
7. **Slow the poll when idle.** The phone's guidance rarely changes; backing off to 6-10 s
   while `drill.running` is false or the guidance version is unchanged halves the load.
8. **Bound the snapshot query** by drill-relevant time; it currently reads up to
   `REPORTS_SNAPSHOT_LIMIT` reports per request.

## Caveats

- One laptop runs generator, server and MongoDB, so absolute numbers are pessimistic for the
  server and the Python generator limits itself near 190 req/s; the before/after comparison
  uses the same setup. Run on the real host from another machine for capacity planning.
- Real phones keep connections alive and sit behind a network; the test opens a new
  connection per request (closer to a worst case for connection setup, not for bytes).
- The synthetic phones send a few reports; real report volume changes `load_snapshot` cost.
- A single drill start state (15:00 replay time, speed 1) was used; replay time changes the
  size of the 2018 record in `command` (it grows as the drill advances).
