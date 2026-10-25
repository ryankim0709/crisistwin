# Backend

Django 5.2 / Django REST Framework, Python 3.12, MongoDB through PyMongo 4. See the root
[README](../../README.md) for Docker and local development commands.

`config/` holds Django configuration; `api/` holds HTTP adapters and contract
tests. `api/mongodb.py` owns the shared connection pool. Keep future simulation
calculations in a separate pure Python package,
with explicit inputs/outputs, without importing Django or provider clients.

## API contract

`GET /api/health` (no trailing slash) is unauthenticated, read-only readiness.
It executes `ping` against the configured MongoDB database and returns
`Cache-Control: no-store`. It creates no collections and writes no records.
The ping checks connectivity and connection authentication when credentials are
supplied; it does not certify collection permissions, data availability, or
artifact integrity.

HTTP 200:

```json
{"status": "ok", "service": "crisistwin-api", "version": "0.1.0"}
```

HTTP 503 when MongoDB is unavailable, authentication fails, or PyMongo rejects
the connection configuration (no driver error or credential details in the body):

```json
{"status": "unavailable", "service": "crisistwin-api", "version": "0.1.0"}
```

Other methods return 405. `status` and `service` are literal strings; `version`
is a nonempty application version string. The frontend validates this boundary
in `src/lib/api.ts`. This endpoint reports service readiness only; it contains
no observations, simulation results, timestamps, coordinates, or physical units.
DRF retains `IsAuthenticated` as the default permission, so new endpoints remain
closed by default; the health route explicitly allows anonymous access. SQL-backed
auth/session apps and middleware are removed, authentication classes are empty,
and unauthenticated users are `None`. Add an explicit authentication/authorization
implementation before introducing shared resources. No shared scenario resources
exist yet.

## MongoDB configuration and boundary

- `MONGODB_URI`: required server-side `mongodb://` or `mongodb+srv://` URI; never
  expose it through a `VITE_*` variable. Compose reads the shell or `app/.env`;
  host Django reads only the shell. To use the team setup, export it from
  `~/.mongodb_uri` without printing the value. Django stores it under a secret
  setting and redacts the environment key from debug exception metadata.
- `MONGODB_DATABASE`: defaults to `crisistwin`, explicitly overriding the URI
  path; 1–63 ASCII letters, digits, underscores, or hyphens. This matches the
  team's database-scoped Atlas access even when its URI has no database path.
- `get_database() -> pymongo.database.Database[dict[str, Any]]`: shared database
  handle for future server-side adapters. One lazy, thread-safe client pool per
  worker, closed on normal process exit. Do not initialize it before forking.
  Datetimes decode as timezone-aware UTC. Provider, HTTP, and numerical model
  code must remain separate; no document schema is introduced in this change.
- Client-side operation, server selection, socket, and connection timeouts are
  each 3,000 milliseconds. There is no application retry loop. Cold SRV DNS
  resolution occurs during client creation and may add startup latency.

Missing URI/scheme or invalid database names fail startup with a credential-free
configuration error. Network/authentication failures return readiness 503 and can
recover on a later request. Django's SQL `DATABASES` is empty; do not run `migrate`
or `makemigrations`. No existing application data is migrated, and no Atlas users,
network rules, collections, or historical artifacts are changed by app startup.
The historical replay data tooling is a separate branch/integration; this change
does not implement artifact upload/download or expose those datasets over HTTP.

See [ADR 0008](../../docs/adr/0008-mongodb-backend.md) for the architecture tradeoff.

### `POST /api/replay/explain`

Optional AI explanation of a replay (paid Anthropic API, model `claude-opus-5-5`).
Implemented in `api/explain.py`; the client is `src/replay/ai/`. Anonymous for the
local demo and throttled to 10 requests per minute per client IP. The model only
explains the numbers it is sent: the system prompt forbids new figures, routes,
capacities or confidence levels, requires field citations and evidence classes,
and forbids directive phrasing. The context is treated as data, not instructions.

Request (body at most 64 000 bytes; canonical `context` JSON at most 48 000 chars):

```json
{"question": "Why did congestion form here?",
 "context": {"incident": {"id": "camp-2018-paradise-slice", "name": "Camp Fire (2018)"},
             "clock": {"now_utc": "2018-11-08T18:00:00Z"},
             "metrics_now": {"exposed_veh": 120, "evidence_class": "simulated"},
             "traffic_summary": {}, "insights": {}, "recent_events": [],
             "closures": {"closure_events_so_far": 40, "edges_closed_now": 12},
             "layer_status": {}, "assumptions": [], "limitations": []}}
```

`question` is 1–500 characters. `context` allows only the keys shown; `incident`,
`clock` and `layer_status` are required. The frontend builds it from the loaded
bundle at the current clock (`src/replay/ai/context.ts`).

HTTP 200 (`Cache-Control: no-store`):

```json
{"answer_markdown": "…", "model": "claude-opus-5-5", "generated_at": "2026-10-23T21:40:00Z",
 "evidence_class": "ai_explanation", "context_digest": "sha256:<hex of canonical context>"}
```

Errors are `{"error": "<code>", "detail": "<human-readable>"}`: 400
`invalid_request`, 413 `too_large`, 429 throttled (DRF `{"detail"}`) or
`upstream_rate_limited`, 503 `ai_unavailable` (no `ANTHROPIC_API_KEY`, or the key was
rejected), 504 `upstream_timeout` (90 s, one retry), 502 `upstream_*` for other
provider errors, refusals or empty answers. Requests use server-side refusal
fallback (`fallbacks: "default"`).

Set `ANTHROPIC_API_KEY` in the backend's environment to enable it (see
`app/.env.example`). Never put it in frontend code or `VITE_*` variables. The
endpoint does not query MongoDB. Run the backend with a gunicorn timeout longer than a
model call, e.g. `gunicorn config.wsgi -b 127.0.0.1:8000 --timeout 120`.

### `GET /api/landscapes` and `GET /api/landscapes/<region_id>`

Public (`AllowAny`), read-only GET/HEAD endpoints in `api/landscapes.py` over the GridFS
bucket `landscape_packages` written by the offline builder (ADR 0013). The server never
writes and never creates indexes. Recommended index (the builder/uploader may create it):

```js
db.getCollection("landscape_packages.files").createIndex({ "metadata.regionId": 1, "metadata.builtAt": -1 })
```

List: `{"regions": [{id, name?, counties?, summary?, center?, radiusMeters?, cellMeters, width,
height, builtAt, bytes, sha256}]}`, newest package per `metadata.regionId`, at most 100,
`Cache-Control: public, max-age=60`. Catalogue fields (`name`, `counties`, `summary`,
`center`, `radiusMeters`) and lattice fields (`width`, `height`, `cellMeters`, from
`metadata.lattice`) are passed through when the builder stored them and omitted otherwise,
so the client should join missing ones with `src/fire/regions.ts`.

Package: `region_id` must match `^[a-z0-9-]{1,64}$`. Streams the newest package in GridFS
chunks with `Content-Type: application/gzip` (no `Content-Encoding`), `Content-Length`,
`ETag: "<sha256>"` and `Cache-Control: public, max-age=3600`; a matching `If-None-Match`
returns 304. Errors are JSON: 404 `{"error": "not_found"}` for unknown/unbuilt regions,
503 `{"error": "unavailable"}` on MongoDB/GridFS errors (no driver text).

### Geodata cache (`/api/geo/…`) and landscape cache (`/api/landscapes/cache`)

Read-through caches so a board load stops re-downloading public data. Anonymous, no auth.

`api/geo_cache.py`: GET-only proxies with a fixed upstream, a parameter whitelist and
numeric range checks (not an open proxy). Bytes are stored in MongoDB collection `geo_cache`
(`_id` = SHA-256 of the normalised request, `body`, `contentType`, `fetchedAt`), never
expired (drop the collection to refresh). Responses carry `Cache-Control: public,
max-age=604800, immutable`, an `ETag` (304 on match) and `X-Geo-Cache: HIT|MISS`. Upstream
calls time out at 40 s and retry 3 times on network errors, 5xx and 429. If MongoDB is
down the request is still proxied, just not stored. Errors: 400 `invalid_request`, 404
`not_found`, 502 `upstream_<status>`.

- `GET /api/geo/landfire/wcs?service=WCS&version=2.0.1&request=GetCoverage&coverageId=<id>&subset=X(min,max)&subset=Y(min,max)[&scalesize=i(n),j(n)&interpolation=<nearest-neighbor URI>]&format=image/tiff`:
  LANDFIRE LF2025 GeoServer WCS (`edcintl.cr.usgs.gov`), the same query the browser sent to
  the Vite `/landfire/wcs` proxy. `coverageId` is one of the five LF2025 FBFM40/CBH/CBD/CC/CH
  CONUS coverages; subsets are EPSG:3857 metres, at most 400 km wide; `scalesize` at most
  2048 per side. Same upstream semantics as `app/vite.config.ts` (browser headers dropped,
  app User-Agent, IPv4 only, last good address reused when DNS fails). Body cap 12 MB.
- `GET /api/geo/terrarium/<z>/<x>/<y>.png`: AWS terrarium elevation tile, z 0-15, 1 MB cap.
- `GET /api/geo/imagery/<z>/<y>/<x>`: USGS `USGSImageryOnly` tile (row before column, as the
  upstream), z 0-17, 2 MB cap.

`api/landscape_cache.py`: write-back cache of finished landscape grids in GridFS bucket
`landscape_cache`, so the next load of the same area is instant. Used by `loadLandscapeCached`
(`app/src/fire/landscapeCache.ts`), which builds the key and the gzip package
(`landscapePackage.ts`, ADR 0013 format).

- `POST /api/landscapes/cache?key=<key>`: body is the gzip package bytes (`Content-Length`
  required, at most 48 MB; must start with the `CTLS1` package magic). `204`; `400
  invalid_key|not_a_landscape_package`, `413 too_large`, `503 unavailable`. One file per
  key (newest wins), at most `LANDSCAPE_CACHE_MAX_FILES` files (default 2000, oldest evicted).
- `GET|HEAD /api/landscapes/cache?key=<key>`: `200` gzip bytes with `ETag` and `Cache-Control:
  public, max-age=3600`, or `404 {"error": "not_found"}`.
- `key` matches `^[a-z0-9][a-z0-9._-]{7,127}$`. The browser's keys look like
  `ls1-c-n122271-37873-r15000-m30` (centre in thousandths of a degree, `n` = negative;
  radius and cell size in metres) or `ls1-b-<minX>-<minY>-<maxX>-<maxY>` (box in 150 m units).

- `GET /api/landscapes/cache/status?keys=k1,k2,...` (up to 200 keys): `{"cached": {key:
  {"bytes", "storedAt"}}, "files": N, "maxFiles": cap}`; metadata only, so pickers can show
  which boards are ready (`app/src/fire/useCachedBoards.ts`).

#### Pre-warming the landscape cache

`tools/prewarm_landscapes/` fills the cache (and the OSM street areas in `dispatch_areas`) for
every board the app can request, so they load instantly: Studio region defaults plus 10, 15, 20,
30, 45 and 60 km half-widths for every catalogue region, Live 15/30/45/60 km at the drill centre
(`/api/demo/environment`) and the historical-fire boards. Needs Node 22, `npm ci` in `app/`,
and the backend on `:8000`. Run from the repo root:

```sh
node tools/prewarm_landscapes/run.mjs --dry-run                     # list boards, what is cached, size estimate
node tools/prewarm_landscapes/run.mjs --state prewarm-state.json    # build missing boards, then streets
node tools/prewarm_landscapes/run.mjs --only live --no-streets      # a subset
```

Boards load through `/api/geo/landfire/wcs` and `/api/geo/terrarium` (raw tiles cached too), two
at a time, then are POSTed to `/api/landscapes/cache`. Street boxes are the same boxes as
`app/src/fire/useBoardStreets.ts` (`allStreetBoxesFor`): the drawn tiles (up to 3x3 per board)
plus every routing-area candidate (the largest box the endpoint takes, 0.26 x 0.2 degrees, slid
across the board in half-box steps, 3x3 on a 30 km board). Roads, evacuation zones, routing and
unit staging run on the candidate holding the most enabled fires, so a board needs only these
fixed boxes. They are requested one at a time, backing off on 429 and 5xx. Boards
already cached are skipped (`HEAD`) and finished street boxes are recorded in the state file, so
re-running the same command resumes. State files from before the routing-area candidates (key
`boxes`, now `streetBoxes`) are re-enumerated once. One board's streets only (here the 30 km
Berkeley Hills & Tilden board; `--only berkeley-hills-tilden` takes every size of the region):
`node tools/prewarm_landscapes/run.mjs --only "studio:berkeley-hills-tilden r15000" --streets-only`.
With a server cap lower than the board count the script
builds only what fits and warns; raise `LANDSCAPE_CACHE_MAX_FILES` and re-run. Measured: about
1.3 MB for a region default, 2 MB for a 60 km board.

### Shared world (`/api/world/…`)

The one active world the workspace tabs read and control, and saved scenarios
([contract](../../docs/shared-world.md), `api/world.py`). Reads are open; writes need the
controller token only when `LIVE_CONTROLLER_TOKEN` is set.

| Endpoint | Purpose |
| -------- | ------- |
| `GET /api/world/active` | The active world (the default world, revision 0, until one is written) |
| `PATCH /api/world/active` | `{baseRevision, updatedBy, changes}`; objects merge, arrays replace; 409 `{world}` on a stale revision |
| `GET /api/world/scenarios` | Saved scenarios, newest first (summaries) |
| `POST /api/world/scenarios` | Save `{name, notes?, tags?, world, extras?}` (extras ≤ 2 MB) |
| `GET /api/world/scenarios/<id>` | One saved scenario with its world and extras |
| `POST /api/world/scenarios/<id>/load` | Make its world active (new revision); returns `{world, scenario}` |
| `DELETE /api/world/scenarios/<id>` | Remove a saved scenario |

### Live broadcast and families

`GET /api/live`, `POST /api/live/broadcast` (`api/live_broadcast.py`) and `/api/families…`
(`api/families.py`) serve the resident iOS app. They use MongoDB collections
`live_broadcast` and `families`. Request and response shapes are in
[ADR 0016](../../docs/adr/0016-resident-live-and-family.md) and
`app/src/live/contracts.ts`.

### Mobile data (`/api/mobile/…`)

`POST /api/mobile/devices` and `/api/mobile/data/<collection>[/<id>]` (`api/mobile_data.py`)
let the iOS app push any JSON object to Atlas and pull it back while its schema is designed.
A device registers once for a bearer token (stored as a hash) and sees only its own documents,
kept in the `mobile_documents` collection (devices in `mobile_devices`). Limits, errors and
examples are in [ADR 0029](../../docs/adr/0029-mobile-data-store.md).

### Command demo (`/api/demo/…`)

`api/demo.py` serves the `/demo` page ([ADR 0047](../../docs/adr/0047-command-demo.md); wire
shapes in `app/src/demo/contracts.ts`). The board follows the live active incident: every
`/api/demo/…` endpoint (also `wind`, `environment`, `crew_routes`, `road_access`; see
[command-demo-realism](../../docs/command-demo-realism.md)) takes an optional `?incident=<id>`.
Absent means Camp (`camp-2018-drill`); allowed are Camp and the active incident (the live API's
rule), anything else is 404 `not_found`. `environment` also returns `stations` and `stations_source`
(the package's OpenStreetMap fire stations; `[]` for Camp), the board's fallback when the CAL FIRE
bases file is absent. Both endpoints below are anonymous for the local demo, answer
`Cache-Control: no-store` and return errors as `{"error", "detail"}`. The game itself runs in the
browser; nothing here is stored.

- `POST /api/demo/routes[?incident=]` `{fires: [ring, ...]}` (at most 60 closed `[lon, lat]` rings of 4-200
  points; body at most 300 kB; 120/min) returns `{zones: [{zone_id, options}], evidence_class:
  "simulated"}`: each drill zone's best route and up to 3 alternatives around the fires, from
  `livecore.routing` over the drill road graph. Distances are metres, `eta_min` minutes.
- `POST /api/demo/decide[?incident=]` `{observation, urgency?}` (at most 200 kB; 40/min) streams `application/x-ndjson`
  like `/api/dispatch/decide`: `thinking`/`text` lines, then one `orders` or `error` line. Claude
  can `send_crew`, `release_crew`, `order_evacuation` (`zone_id`, `destination_id`, `start_minute`:
  absolute board minute departures start, `null` = now, at most 240 min ahead), `cancel_evacuation`
  (`zone_id` of a scheduled zone) or `order_resources` (`fire_id`, `resource`
  one of `engine_strike_team`, `crew_strike_team`, `dozer_strike_team`, `airtanker`, `helicopter`,
  integer `count` up to 5/5/2/4/2; burning fires only); each order is validated against the ids
  in the observation (at most 20 per decision). See [docs/response-model.md](../../docs/response-model.md). Needs `ANTHROPIC_API_KEY` (else 503
  `ai_unavailable`) and reuses `DISPATCH_AGENT_MODEL` and `DISPATCH_AGENT_EFFORT`. `urgency`
  (`"urgent"`, the default, or `"routine"` for the page's continuous reviews) picks the effort:
  urgent uses `DISPATCH_AGENT_EFFORT`, routine `DISPATCH_AGENT_ROUTINE_EFFORT` (default `low`,
  never above the urgent effort); `DISPATCH_AGENT_ROUTINE_MODEL` (default: the urgent model)
  picks the routine model. Prompt caching: tools + system carry a 1-hour breakpoint and the
  run-static half of the observation (`split_observation`: clock constants, inputs, wind
  provenance, crew and department identity fields) a 5-minute one, sent as an
  `<observation_static>` block before the rest. Each decision's token usage (uncached, cache read,
  cache write by TTL, output) and its list-price cost (`dispatch.decision_usage`,
  `MODEL_PRICES_USD_PER_MTOK`) is logged by `api.dispatch` at INFO (`config/settings.py`
  `LOGGING`) and sent as `usage` on the final NDJSON line (also on an error line after the model
  answered). Cost notes: [docs/command-demo-realism.md](../../docs/command-demo-realism.md) "AI agent cadence".

### Live drill API (`/api/live/…`)

Implements v1 and v2 of [docs/live-reports.md](../../docs/live-reports.md) (ADR 0011, 0012):
field reports, road state, public map, check tasks, the drill clock, the fire estimate,
per-zone guidance with controller proposals, check-ins and responder location. Code:
`api/live/` (HTTP + MongoDB) over the pure `livecore/` package (rules, planner, routing).
Everything is a labeled drill of the 2018 Camp Fire; nothing is a real incident. It shares
the `/api/live` prefix with the broadcast above but no code or collections (`live_*`).

- Studio fires: `POST /api/live/studio-fires` (controller) publishes a simulated fire scenario for the active incident; `GET /api/live/incidents/<id>/studio-fires[?after=]` lists the newest 10 (`api/live/studio_fires.py`; [contract](../../docs/live-reports.md#studio-fires)).
- Auth: `Authorization: Bearer <token>`. `POST /api/live/devices` issues civilian tokens;
  `POST /api/live/incidents/camp-2018-drill/join {"invite_code"}` issues responder tokens
  (`LIVE_INVITE_CODE`, unset -> 403). The controller needs no token while
  `LIVE_CONTROLLER_TOKEN` is unset; setting it requires that bearer token. Device tokens are stored as SHA-256 hashes.
- The planner fixes every level, route and number. The rationale LLM
  (`LIVE_RATIONALE_MODEL`, `ANTHROPIC_API_KEY`) only rewrites the template text in a
  background thread (10 s timeout); without a key the template stays.
- `LIVE_DRILL_BUNDLE` points at the replay bundle (default
  `app/public/replays/camp-2018.json`); it is parsed once per process on first use.
- `POST incidents/{id}/impact` (controller) compares one road segment blocked and unblocked:
  two planner runs give the affected zones and their ETA delta, and one twin what-if
  (simulated, about 1-3 s) gives the vehicles at risk and window metrics (`api/live/impact.py`).
- `GET incidents/{id}/aar` (controller) returns the after-action report and drill score
  (`api/live/aar.py`; [contract](../../docs/live-reports.md#after-action-report)).
- `GET incidents/{id}/snapshot` and `GET incidents/{id}/snapshot/households?zone_id=&limit=&after=` (any
  live token): the scenario resource snapshot (households, stations, engines at T+0; `404 no_snapshot`
  until `python manage.py live_seed_snapshots`; `api/live/snapshots.py`,
  [contract](../../docs/scenario-snapshots.md)).
- Not implemented yet: `POST incidents/{id}/route` returns 501.

Local run (Docker MongoDB on 127.0.0.1:27017):

```sh
export MONGODB_URI=mongodb://127.0.0.1:27017 MONGODB_DATABASE=crisistwin_live_dev
export LIVE_CONTROLLER_TOKEN=dev-controller LIVE_INVITE_CODE=DRILL
python manage.py live_init_db            # indexes + validators, once per database
python manage.py live_drill --reset --seed   # start the clock; add labeled drill-fixture reports
python manage.py runserver 127.0.0.1:8000
```

`live_drill` also takes `--speed` (0..60 drill seconds per wall second) and
`--replay-start`. `--seed` inserts three synthetic civilian reports of a full block on
Skyway in Paradise (`evidence_class: "drill_fixture"`, note says synthetic).
`live_init_db --drop-drill-data` drops all live drill data but keeps device tokens.

`python manage.py live_smoke` (same env, server running) checks the whole phone ↔ `/live` loop
over HTTP in about 5 s, with no simulator or browser: report, triage, replan and approve,
guidance on the phone, destination choice, check-ins, responder position and a check task. It
writes synthetic drill data; run `live_drill --reset` afterwards. Its replan/approve step needs
`LIVE_PROPOSALS=true` on the server (off by default: `/live` follows the AI agent).

`python manage.py live_compare_record --confirm-delay-min 5 --out /tmp/record-compare` (same env;
no server, no database writes, about 1-2 min) is a simulated planning experiment: the live twin
and planner headless from 14:30Z to 18:00Z, without a controller, with one who confirms the 2018
record's `road_blocked`/`fire_seen` entries N minutes late, and with the previous free-flow
planner. It writes `.json` and `.md`; see [live-reports.md](../../docs/live-reports.md)
("Record comparison harness") and ADR `0031-congestion-aware-planner.md`.

`python manage.py live_loadtest --base http://127.0.0.1:8020 --ramp 10,50,100,200 --duration 30
--out results.json` ramps simulated phones and consoles against a server started with
`LIVE_LOADTEST_RELAX_LIMITS=1` and prints p50/p95/p99 per endpoint; `--cleanup` removes its
data. Use a separate server and database, never the shared one. Method and results:
[docs/live-loadtest.md](../../docs/live-loadtest.md).

`python manage.py live_batch --spec api/live/specs/camp-2018-pilot.json --strategies
historical_only,rule_auto,record_delay_5 --workers 8 --out /tmp/batch-pilot` (same env; no
server, no database writes; about 3 min for 24 runs on 8 cores) is the headless batch runner:
scenario × strategy × seed in lockstep on the drill clock, scored with the AAR in drill minutes,
one `RunManifest` per run and a paired comparison table. Simulated planning experiments; see
[batch-runner.md](../../docs/batch-runner.md) and ADR `0049-batch-runner.md`.

### Voice mode (`POST /api/live/incidents/<id>/voice`)

One turn of the phone's voice mode: speech in, a spoken reply and at most one proposed phone
action out. Any live bearer token works; 12 turns per minute per device; nothing from a turn is
stored. Code: `api/live/voice.py` (endpoints, validation, prompt) and `api/cartesia.py`
(Cartesia batch speech-to-text `ink-whisper`, batch text-to-speech and access-token minting over
stdlib `urllib`). Two more things sit beside the batch turn: `POST /api/live/incidents/<id>/voice/token`
returns a 300 s Cartesia token (`stt` and `tts` grants only; 6 per minute per device; 503
`voice_unavailable` unless both `CARTESIA_API_KEY` and `ANTHROPIC_API_KEY` are set) so the phone can
stream speech to and from Cartesia directly, and `"stream": true` on the turn returns the reply as
NDJSON. When `TYPESAFE_API_KEY` is set, Jev
(`api/jev.py`, `api/live/voice_decide.py`) decides clear turns first and Claude takes the rest. Either
only proposes: the phone asks the person before it sends a report or check-in through the ordinary
endpoints, except that a confident first-hand hazard report comes back `auto: true` for the phone to
file, with undo. Request and response shapes, action types, limits, error codes and what leaves the
phone: [docs/live-reports.md "Voice mode"](../../docs/live-reports.md#voice-mode).

Environment (server-side only, never `VITE_*`; placeholders in `app/.env.example`):

| Variable | Required | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | Paid. Without it every voice turn answers 503 `voice_unavailable` |
| `CARTESIA_API_KEY` | for audio and tokens | Paid Cartesia key for speech-to-text and text-to-speech. Stays on the server; the phone gets only short-lived tokens. Without it, audio turns and `voice/token` answer 503 `voice_unavailable`; `text` turns work (`tts: "skipped"`, or `"client"` when streaming) |
| `CARTESIA_VOICE_ID` | no | Cartesia voice for replies. Default: Cartesia's documented example voice (`DEFAULT_VOICE_ID` in `api/cartesia.py`) |
| `CARTESIA_TTS_MODEL` | no | Default `sonic-3.6` |
| `VOICE_MODEL` | no | Claude model that interprets the turn. Default `claude-opus-5-5` |
| `TYPESAFE_API_KEY` | no | Paid TypeSafe key for Jev (`api/jev.py`, `POST https://api.typesafe.ai/v1/systemone`, 4 s timeout). When set, Jev decides each turn first and Claude handles questions and anything Jev is unsure about; when unset, Claude handles every turn. `ANTHROPIC_API_KEY` is still required. See [Decisions (Jev)](../../docs/live-reports.md#decisions-jev) |
| `JEV_MODEL` | no | Jev model id. Default `jev-latest` |

Try it without a microphone, using a `text` turn (no audio, no Cartesia call). Start the backend
and drill as in "Local run" above, with `ANTHROPIC_API_KEY` exported, then:

```sh
TOKEN=$(curl -s -X POST http://localhost:8000/api/live/devices | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
curl -s -X POST http://localhost:8000/api/live/incidents/camp-2018-drill/voice \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"text": "pentz road is completely blocked", "speak": false,
       "context": {"zone": "Paradise Zone 4", "role": "civilian", "guidance": null,
                   "pending": null, "history": []}}'
```

The answer has `transcript`, `reply` (for example "Report a fully blocked road here. Send it?"),
`action` (a `report` proposal, nothing is sent), `audio_b64: null`, `tts: "skipped"` and
`evidence_class: "ai_interpretation"`. The wording and action come from the model and vary.
Each call is paid Anthropic usage. This has not been run against a live key from this
documentation change.

The streaming path takes `text` only and needs `ANTHROPIC_API_KEY` but not Cartesia. `-N` turns off
curl's buffering so the lines show up as the model writes them:

```sh
curl -N -X POST http://localhost:8000/api/live/incidents/camp-2018-drill/voice \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"text": "pentz road is completely blocked", "stream": true,
       "context": {"zone": "Paradise Zone 4", "role": "civilian", "guidance": null,
                   "pending": null, "history": []}}'
```

The answer is `application/x-ndjson`: several `{"type": "reply_delta", "text": "..."}` lines, one
`{"type": "reply_end"}`, then a `{"type": "final", ...}` line with `reply`, `action`, `streamed`,
`spoken_extra` and `tts: "client"` (or an `{"type": "error", ...}` line if the model call fails
after the stream has started). Errors found before the model is called are ordinary JSON with an
HTTP status. Line shapes: [docs/live-reports.md "Streaming
voice"](../../docs/live-reports.md#streaming-voice-token-endpoint-and-ndjson-replies).

The token endpoint, with the same `$TOKEN` (needs both keys; each call mints a real Cartesia
token, which expires after 300 s):

```sh
curl -s -X POST http://localhost:8000/api/live/incidents/camp-2018-drill/voice/token \
  -H "Authorization: Bearer $TOKEN"
```

It answers `{"token": "...", "expires_in": 300, "version": "...", "stt": {...}, "tts": {...}}`
with the WebSocket URLs, models, voice and audio formats the phone should use. Treat the token like
a credential for five minutes: do not paste it into logs or screenshots.

The streaming and token examples have not been run from this documentation change; the latency
figures in the contract come from earlier runs on the local stack.

### Incident intelligence (`/api/intel/…`)

Public agency pages, fetched by the Apify Actor in `actors/incident-intel/`, become source
documents; Claude extracts candidate events from one document at a time; a planner confirms,
maps or rejects each candidate. Full request/response shapes, field rules and examples:
[docs/incident-intel.md](../../docs/incident-intel.md) (decision:
[ADR 0018](../../docs/adr/0018-apify-incident-intelligence.md)). Views in `api/intel.py`,
prompt/schema/candidate rules in `api/intel_extract.py` (pure), Apify wrapper in
`api/intel_apify.py`. MongoDB collections `intel_runs`, `intel_documents`,
`intel_candidates`.

| Endpoint | Purpose |
| -------- | ------- |
| `POST /api/intel/runs` | Start the Actor on Apify (paid; 5/min). 202 `{run_id, dataset_id, status, incident, started_at}` |
| `POST /api/intel/ingest` | Store Actor output by `run_id`, `dataset_id`, or uploaded `items` (<= 2 MB, <= 200). `sha256` is recomputed; no extraction |
| `GET /api/intel/documents?incident=` | Stored documents (excerpt, no full text) |
| `POST /api/intel/documents/<document_id>/extract` | Claude extraction of one document (paid; 10/min) |
| `GET /api/intel/candidates?incident=&status=&types=&as_of=&bbox=` | Candidates, sorted by `available_at`, at most 500 |
| `POST /api/intel/candidates/<event_id>/review` | Planner confirm/reject/reset; confirming a road event requires `mapping.point` |

Every candidate is `evidence_class: "reported"` and starts `review_status: "unconfirmed"`;
only the review endpoint changes it. Claude copies text and categorises; it never outputs
coordinates or edge ids, and an event whose quote is not in the page is dropped. Page text is
sent inside `<scraped_page>` tags as untrusted data. Endpoints are anonymous for the local demo,
throttled, and answer `Cache-Control: no-store`; errors are `{"error", "detail"}`.

Environment (server-side only, never `VITE_*`): `APIFY_TOKEN` and `APIFY_ACTOR_ID` enable
runs and ingest by run/dataset id; without them (or without the `apify-client` package) those
answer 503 `apify_unavailable`, while uploading `items`, listing, review and export still
work. `ANTHROPIC_API_KEY` enables extraction; without it, 503 `ai_unavailable`. MongoDB
outages answer 503 `database_unavailable`.

### Dispatch area exits = safe areas (`GET /api/dispatch/area`)

The road graph, zones and stations are described in
[ADR 0017](../../docs/adr/0017-dispatch-anywhere.md). Since builder `dispatch-area/6` (wire
schema still 2, additive; the version bump refreshes cached areas) exits are **safe areas**:
places people go, away from the fire, inside the box or beyond it, not where roads cross the
box edge.

- **Places.** Within 30 km of the box centre (more for a large box), merged from three sources;
  listings within 300 m are one place and the better source wins (official > FEMA > OSM):
  - officially designated places curated with citations in `api/dispatch_safe_areas.json`
    (the City of Berkeley "Shelter Sites" layer, 13 sites, capacity from the FEMA record of the same building where one exists; the City publishes no temporary evacuation point list; `excludeListings` drops a mislocated FEMA record);
  - registered shelter facilities from FEMA's ESF#6 Shelter System, formerly the National
    Shelter System (public ArcGIS service `gis.fema.gov/arcgis/rest/services/NSS/FEMA_NSS/FeatureServer/5`,
    "Shelter Locations"; US federal data, no licence stated in the service; attribution: FEMA,
    Mass Care, American Red Cross). Most are `CLOSED` (registered, not open now); the status is
    passed through;
  - OSM `emergency=assembly_point`, `emergency=evacuation_centre|shelter` and
    `social_facility=shelter` (homeless and similar shelters excluded) (© OpenStreetMap
    contributors, ODbL).
  FEMA and OSM are both queried (since `shelters/2`) and cached together in MongoDB
  `dispatch_shelters` (key: `shelters/2`, centre rounded to 0.01°, radius).
- **Capacity** (people, on the exit as `capacity` and on `destination.capacity`): the source's
  figure (FEMA `evacuation_capacity`, OSM `capacity=*`, curated), else an ASSUMPTION per kind
  (`ASSUMED_CAPACITY_PEOPLE`: shelter 300, evacuation centre 500, temporary evacuation point
  1000, assembly point 500; reported in `assumptions.assumedSafeAreaCapacityPeople`), marked
  `destination.capacityBasis: "assumption"` with `capacitySource`.
- **`kind: "safe-area"`**: a place inside the box. `node` is the nearest public road node,
  `approachMeters` the straight line from it. Every official place, plus the best other place
  per 2.5 km cell (largest capacity), up to 24 (product choices, not sourced), named
  `"<place> (<kind>)"`.
- **`kind: "egress"`**: a place beyond the box, reached by a motorway, trunk or primary (then
  secondary) road crossing the box edge in the direction traffic can leave, kept only when the
  place lies within 75° of the road's outward heading (an assumption). At most 6, one per road
  first, named `"Hwy 24 east → <place> (<kind>)"`. The distance is straight-line: roads beyond
  the box are not routed. `destination.key` names the place, so two roads to one shelter share it.
- **`kind: "map-edge"`**: only when no egress toward a known place exists, up to 6 deduplicated
  major-road crossings, `"<road> (<side>) · approximate exit (map edge)"`, capacity null. They
  stay beside the safe areas as the last resort.
- Every exit: `{id, name, node, road, side, kind, inside, approachMeters, capacity, destination?:
  {key, name, kind, source: "official"|"fema-nss"|"osm", sourceId, sourceUrl, city, location:
  [lon, lat], capacity, capacityBasis, capacitySource, status, straightLineMeters}}`.
  `sources.shelters` reports `{source: "fema-nss+osm" | "fema-nss" | "osm" | null, attribution,
  searchRadiusMeters, found}` and `sources.safeAreas` the counts per kind.
- **Per incident** the area does not decide which places are open: the drill package
  (`livecore/package.py`) turns safe areas into `shelter` destinations and egress/map-edge into
  `exit` destinations with `capacity_veh`, and the command board closes destinations the fire
  is forecast to reach or that are full (`app/src/demo/safeDestinations.ts`, sent as
  `excluded_destination_ids` to `POST /api/demo/routes`).

## Updating dependencies

Edit the `.in` files, then resolve with [uv](https://docs.astral.sh/uv/pip/compile/):

```sh
uv pip compile requirements.in --python-version 3.12 --output-file requirements.txt
uv pip compile requirements-dev.in --constraint requirements.txt --python-version 3.12 --output-file requirements-dev.txt
```

Review and keep both generated lockfiles. Installation uses pip; uv is only
needed when changing the Python dependency set. Atlas credentials stay local, and only
the optional explain, dispatch and intel extraction endpoints need a provider key
(`ANTHROPIC_API_KEY`); intel runs need `APIFY_TOKEN`/`APIFY_ACTOR_ID`; voice mode also needs
`ANTHROPIC_API_KEY`, and `CARTESIA_API_KEY` for audio.
Optional existing contract tests mock the MongoDB boundary; they still require a
syntactically valid `MONGODB_URI` environment variable to load Django settings.

### Simulation state (`/api/sim-state/…`)

`api/sim_state.py` stores the Studio's evacuation run and serves per-home advice to the
iOS app. Everything is simulated (synthetic homes and addresses). No auth; throttled.
Collections `sim_runs` (run, zones, current tick state) and `sim_homes` (one document per
home with a 2dsphere `location`); only the 3 newest runs are kept. Full contract, limits
and documents: [`docs/sim-state-api.md`](../../docs/sim-state-api.md).

- `POST /api/sim-state/runs`: publish a run (zones and homes), returns `201 {run_id}`.
- `POST /api/sim-state/runs/<run_id>/tick`: push the state at one simulation minute.
- `GET /api/sim-state/latest`: latest run, current minute and per-zone state.
- `GET /api/sim-state/advice?lon=&lat=` or `?home_id=`: advice for one home.
- `GET /api/sim-state/homes?q=&limit=`: address search.
