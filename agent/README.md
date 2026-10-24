# Fire watch agent

`crisistwin_agent` is a standalone Python package that watches an area for
satellite fire detections, projects where a detected fire could go using the
fire model CrisisTwin already has, works out which modelled assets that
footprint reaches, and drafts an evacuation advisory for a human planner to
approve or reject. It is built on the Anthropic Python SDK and runs as a local
process, outside Django and outside the browser app.

It is **not** a fire detector, a perimeter product, an alerting system, or a
source of operational guidance. It does not notify residents, and it has no
channel that could. It reads a public satellite feed, runs a simulation, and
writes a draft that a named person must sign before it goes anywhere.

## Status

V1 is in place: every module in the layout table below is on disk, and the
stages have been exercised from the tool layer down, including real runs of the
fire model against live LANDFIRE fuel and terrain.

The loop has been run end to end on `claude-opus-5`, driving the real fire model
over live LANDFIRE data. In that run the agent projected both detection
clusters, assessed both, drafted an advisory only for the one with exposure, and
reported the other as reaching nothing — without being told to do either.

Two behaviours worth knowing, because they are the point of the design:

- Asked to project without a fuel-moisture preset, the agent chose one and then
  said so, labelling it *its own* assumption and distinct from the wind the
  operator supplied. It did not quietly adopt a default and report the result as
  if the input were given.
- It surfaced the model's own warning that a 30 mph effective wind is past
  Rothermel's validated range, and named that as the largest caveat on its
  headline arrival time, rather than reporting the figure flat.

The figures quoted in the demo section below are from real runs. Nothing else
here is a transcript. Treat a difference between this README and the code as a
bug in whichever was written second, and fix both.

## The loop

One watch run is six stages. Each stage is a tool the model can call; the model
decides when to call them and in what order, and reads what comes back.

1. **Watch** — poll NASA FIRMS for satellite fire detections inside an area of
   interest (`detection/firms.py`), or read the offline fixture source
   (`detection/fixtures.py`) so the demo runs without a key or a network. A
   detection is an observation of *heat*, not a fire perimeter and not a
   confirmed fire.
2. **Cluster** — group detections that are plausibly one fire
   (`detection/clustering.py`). The grouping is a heuristic over pixel
   positions, recorded as `DetectionCluster.grouping_method`; it is not a
   finding about how many distinct fires exist.
3. **Project** — drive the existing TypeScript Rothermel model in `app/src/fire/`
   through a Node stdio sidecar (`bridge/fire-bridge.mjs` and
   `crisistwin_agent/simulation/bridge.py`) to get a projected footprint over a
   horizon. The physics is not reimplemented in Python.
4. **Assess** — intersect the projected footprint with an asset registry to find
   which neighborhoods, shelters, and roads it reaches, and at what elapsed
   simulation minute (`exposure.py`).
5. **Draft** — assemble an evacuation advisory that cites the evidence it rests
   on: which detections, which model run, which assumptions (`advisory.py`).
   The advisory is created as a `draft`.
6. **Gate** — a draft becomes deliverable only after a named human approves it.
   `EvacuationAdvisory.approve(approver)` records who; every `AdvisoryChannel`
   must raise `ApprovalRequiredError` for anything that is not approved. The
   only channel in V1 reaches planners. There is no resident-facing channel.

## The rule: Claude orchestrates, it never computes

Claude's job in this package is interpretation, tool orchestration, and
explanation. Claude **never** produces a perimeter, an arrival time, a
population figure, or a confidence level. Those come from the fire model and
the asset registry, through tools, and the model reads them back. This is the
central architectural rule of the component and the reason the tool boundary is
drawn where it is; it follows `AGENTS.md`, which allows an LLM to interpret
intent and explain results but not to invent computed metrics.

The same rule is why ports fail loudly. Every external dependency in
`ports.py` is a `Protocol` that raises `PortUnavailableError` when it cannot
answer, and the tool layer is intended to turn that into an error tool result
rather than an empty success. An empty list from a detection source means *the
source answered and had nothing*, which is a real and useful result. A missing
key, a network failure, or ground outside LANDFIRE coverage is not an empty
list, and nothing in this package substitutes a plausible number for a missing
one.

## Model configuration

The loop runs on `claude-opus-5` through `client.beta.messages.tool_runner`,
with adaptive thinking and `output_config.effort="high"`. Server-side refusal
fallbacks are on by default — `betas=["server-side-fallback-2026-07-01"]` with
`fallbacks="default"` — so a refused turn is routed by category rather than
failing the run; `AgentConfig.enable_refusal_fallbacks` turns that off for a
deployment whose SDK or endpoint rejects the parameter.

A watch run is bounded. `AgentConfig.max_turns` (default 24) is enforced both
by the package's own turn counter and by the tool runner's `max_iterations`, so
the loop cannot run away. `tool_runner` is a beta surface on
`client.beta.messages`, which is why `requirements.in` holds the SDK to one
major version.

## Layout

Every path below is on disk.

| Path                                       | Role                                                          |
| ------------------------------------------ | ------------------------------------------------------------- |
| `crisistwin_agent/domain.py`               | Value objects, units, and the `Evidence` provenance type.      |
| `crisistwin_agent/ports.py`                | Protocols and errors for every external dependency.            |
| `crisistwin_agent/config.py`               | Environment and run configuration (`AgentConfig`).             |
| `crisistwin_agent/prompts.py`              | System prompt and the standing caveats.                        |
| `crisistwin_agent/tools.py`                | The tool surface the model is given.                           |
| `crisistwin_agent/runner.py`               | The agent loop over `client.beta.messages.tool_runner`.        |
| `crisistwin_agent/__main__.py`             | CLI entry point.                                               |
| `crisistwin_agent/detection/firms.py`      | NASA FIRMS adapter.                                            |
| `crisistwin_agent/detection/fixtures.py`   | Offline fixture detection source.                              |
| `crisistwin_agent/detection/clustering.py` | Detections to candidate fires.                                 |
| `crisistwin_agent/simulation/bridge.py`    | Python side of the Node sidecar.                               |
| `crisistwin_agent/exposure.py`             | Footprint against the asset registry.                          |
| `crisistwin_agent/advisory.py`             | Advisory drafting, rendering, and the planner review channel.  |
| `bridge/fire-bridge.mjs`                   | Node side of the sidecar; runs the model in `app/src/fire/`.   |
| `bridge/package.json`                      | The sidecar's own npm manifest and lockfile.                   |
| `fixtures/berkeley_detections.json`        | Synthetic offline detections for the demo.                     |
| `fixtures/berkeley_assets.json`            | Synthetic asset registry: neighborhoods, shelters, roads.      |

## Setup

Python **3.12** matches the rest of the repository (root `README.md`, ADR 0001).
The Anthropic SDK itself requires 3.10 or newer. From the repository root:

```sh
cd agent
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

`.venv/` is already ignored by the repository `.gitignore`.

**`requirements.txt` is a `pip freeze`, not a `uv pip compile` lockfile.** The
project convention (`app/backend/README.md`) is to compile `.in` to `.txt` with
uv, but neither uv nor Python 3.12 was installed on the machine where this
dependency set was first resolved, so it was resolved by installing
`requirements.in` into a CPython 3.13.5 virtual environment and freezing the
result. The exact commands, the date, and what that costs you — no `# via`
provenance, and compiled-wheel pins that are specific to 3.13 on arm64 — are in
the header of `requirements.txt`. Recompile it with uv when uv is available:

```sh
uv pip compile requirements.in --python-version 3.12 --output-file requirements.txt
```

`anthropic` is the only direct dependency. Everything else the package needs is
in the standard library; the fire physics stays in TypeScript.

### Node sidecar prerequisite

Stage 3 runs the TypeScript model through a Node process, so Node.js is a
runtime prerequisite of the agent, not just of the web app. `agent/bridge/` is
its own small npm package with its own manifest and lockfile, separate from
`app/`, and it requires Node **22.15+** — slightly above the 22.12 floor in
`app/.nvmrc`:

```sh
node --version
cd bridge && npm ci && cd ..
```

The sidecar's only dependency is TypeScript, for loading the model's `.ts`
modules. ADR 0004 keeps `fuelModels.ts`, `rothermel.ts`, and `spread.ts` free of
React, DOM, MapLibre, and network code, and `landscape.ts` uses `fetch`, which
Node provides, so no part of the browser app's dependency set is needed here.
The Python side is intended to see only the stdio protocol, and to surface a
sidecar failure as `PortUnavailableError` rather than as a missing projection.

The sidecar needs outbound internet access: the model fetches LANDFIRE fuel and
elevation rasters per run.

## Environment

Copy the example and fill in your own values:

```sh
cp .env.example .env
```

| Variable                       | Required                      | What it is                                               |
| ------------------------------ | ----------------------------- | -------------------------------------------------------- |
| `ANTHROPIC_API_KEY`            | yes                           | Anthropic API key. `ANTHROPIC_AUTH_TOKEN` or an `ant auth login` profile works too. |
| `FIRMS_MAP_KEY`                | for live detections           | Free NASA FIRMS key, from https://firms.modaps.eosdis.nasa.gov/api/map_key/ |
| `CRISISTWIN_AGENT_MODEL`       | no                            | Model id. Default `claude-opus-5`.                        |
| `CRISISTWIN_EFFORT`            | no                            | `low`–`max`. Default `high`.                              |
| `CRISISTWIN_MAX_TURNS`         | no                            | Per-run turn ceiling. Default 24.                         |
| `CRISISTWIN_DETECTION_SOURCE`  | no                            | `firms` or `fixture`.                                     |
| `CRISISTWIN_FIXTURE_PATH`      | no                            | Detection fixture. Default `fixtures/berkeley_detections.json`. |
| `CRISISTWIN_NODE_BIN`          | no                            | Node executable for the sidecar. Default `node` on PATH.  |
| `CRISISTWIN_HORIZON_MINUTES`   | no                            | Projection horizon: 120, 180, or 360. Default 180.        |
| `CRISISTWIN_LOG_LEVEL`         | no                            | Python logging level. Default `INFO`.                     |

`crisistwin_agent/config.py` holds these names and the defaults; a malformed
value is an error there rather than a silent fallback.

`.env` and `.env.*` are gitignored at the repository root; `.env.example` is
the only one that is committed, and it holds placeholders. Keep both keys out
of Git, logs, fixtures, screenshots, and the browser bundle under `app/`.
FIRMS puts its key in the request URL, so a logged FIRMS URL is a leaked key:
do not log built URLs, and strip the key from any recorded fixture.

## Running it

The entry point is the package itself, run from `agent/`:

```sh
.venv/bin/python -m crisistwin_agent --help
```

A run needs an area of interest and a detection source. `--help` is the
authority on the full flag list.

### The offline demo scenario

This command runs the whole loop without a FIRMS key. It still reaches the
network, because the fire model fetches real LANDFIRE fuel and terrain:

```sh
.venv/bin/python -m crisistwin_agent \
  --source fixture \
  --lookback-hours 168 \
  --horizon-minutes 360 \
  --wind-speed-mph 30 --wind-from-degrees 225
```

The wind matters, and the reason is worth understanding before demonstrating
this. The synthetic registry's assets lie north-east of the fixture ignition
point, so under a north-easterly Diablo wind the modelled fire runs *away* from
them and nothing is exposed — a correct result, and the tool refuses to draft an
evacuation advisory for it rather than producing an empty one. Under the
south-westerly above, the fire runs into the synthetic Tilden Gate neighbourhood.
Driving the tools directly with those inputs gives a GS3 grass-shrub ignition,
about 1.3 km of reach and 0.53 km² burned at six hours, Tilden Gate first
covered at T+15 min, and 610 synthetic residents in the exposure total.

Those figures come from the real model over real fuel data, but every one of
them describes an invented fire against an invented asset registry.

A run ends at a **draft**. Approval is a separate, deliberate human act — the
loop cannot perform it, and delivery of an unapproved advisory is refused with
`ApprovalRequiredError`.

## What is real and what is invented

Keeping these apart is the point of `Evidence` in `domain.py`. Every record
that reaches the model or a report carries the provenance that says which kind
of claim it can support, and deriving data never widens a narrower kind.

| Evidence kind      | In this component                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `observation`      | NASA FIRMS satellite fire detections — real, public, near-real-time MODIS and VIIRS thermal anomalies. |
| `recorded-fixture` | The offline detection source. Labelled `RECORDED FIXTURE - not live data` wherever it appears, and never presented as live. |
| `simulation`       | Every projected perimeter, arrival time, exposed asset, and exposure minute. LANDFIRE fuel and terrain under them are real public products; what the model does with them is simulated. |
| `assumption`       | Wind speed, wind direction, and fuel moisture, unless something observed is attached.     |

Two things that the kind names alone do not make obvious:

**The offline detection fixture is synthetic, not a recording.** The hot pixels
in `fixtures/berkeley_detections.json` were authored by hand so the demo runs
without a key or a network. They came from no satellite, they record no real
fire, and they describe no real conditions in the Berkeley Hills. They ride on
the `recorded-fixture` evidence kind, which is what keeps them labelled as not
live, but "fixture" here means invented rather than replayed.

**The asset registry is invented too.** The neighborhoods, shelters, roads, and
population estimates in `fixtures/berkeley_assets.json` are synthetic planning
data authored for this project. They are not a census, not a gazetteer, and not
a shelter directory, and they contain no resident data of any kind.
`ExposureAssessment.population_at_risk` is a sum over made-up numbers, and an
advisory that quotes it is quoting the registry, not the world.

## Limitations

Read these before showing anyone a result.

- **Outputs are planning experiments, not operational guidance.** They carry no
  authority approval. Every advisory surface carries
  `EvacuationAdvisory.disclosure()`, and the approval gate exists so that no
  simulated recommendation becomes an instruction by accident. No channel in V1
  reaches residents.
- **Satellite detections lag, and they are not perimeters.** FIRMS publishes
  near-real-time detections roughly within three hours of the overpass; a fire
  that started between overpasses is invisible until the next one. A detection
  is a thermal anomaly in a pixel — about 375 m for VIIRS, about 1 km for MODIS
  — with its own geolocation error. Cloud, smoke, and canopy hide fires; gas
  flares, hot industry, and burn scars produce detections where there is no
  wildfire. Absence of detections is not absence of fire.
- **Clustering is a heuristic.** Grouping pixels is not a determination of how
  many fires exist, or of which detections belong to the same one.
- **The fire model is surface fire only.** No crown fire, no spotting or ember
  transport, no suppression, and no structure-to-structure urban spread. A fire
  that reaches the edge of the vegetation simply stops, which understates real
  risk at the wildland-urban interface. Wind is uniform over the grid and
  constant in time, fuel moisture is uniform, and there is no diurnal weather
  change. See ADR 0004 for the full list.
- **LANDFIRE coverage is the contiguous United States only.** Outside it the
  projection fails with an explicit out-of-coverage error rather than inventing
  fuel. Igniting on ground that carries no fire — water, pavement, bare rock,
  developed land — is refused for the same reason.
- **The asset registry and the offline detection fixture are synthetic**, as
  above, so every exposure count, population figure, and road name in an
  advisory is synthetic too, and an offline run observes nothing at all.
- **No traffic or evacuation-time modelling is wired in.** Nothing here models
  road capacity, departure timing, queueing, shelter capacity, or how long an
  evacuation would actually take. "First exposure at T+45" is when the modelled
  fire reaches a modelled asset, not a warning time and not a deadline.
- **Weather is a planner assumption in V1.** The agent loop as specified has no
  live weather feed; wind and moisture come in with the run. (`app/src/fire/weather.ts`
  has a National Weather Service adapter for the browser app; the agent does
  not use it.)
- **No persistence and no HTTP endpoint.** The agent is a local process. It
  does not save scenarios, and nothing in `app/` calls it.
- **Nothing here has been run end to end yet.** The package is incomplete at the
  time of writing, and no claim in this README should be read as a verified
  result.

## Decisions

See [ADR 0008](../docs/adr/0008-fire-watch-agent.md) for why the loop is built
on the SDK tool runner rather than a graph framework, why the fire model is
driven through a Node sidecar instead of ported to Python, why every dependency
is a port, why advisories are gated on a human, and why this is a standalone
package rather than a Django app. The fire model itself is
[ADR 0004](../docs/adr/0004-physics-fire-model.md).
