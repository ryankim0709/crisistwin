# 0008: Fire watch agent

Date: 2026-10-23. Status: accepted; implementation in progress.

Numbered 0008, not 0007. The directory already carries two 0003 entries and two
0004 entries because parallel branches numbered independently, and
`feat/fire-simulation` took 0007 for the WUI spread mechanisms while this branch
was open. Moved rather than adding a third collision.

## Decision

Build the fire-watch agent as `agent/`, a standalone Python package
`crisistwin_agent` on the Anthropic Python SDK. One watch run is six stages —
poll NASA FIRMS for satellite detections in an area of interest, cluster them
into candidate fires, project a footprint with the fire model that already
exists in `app/src/fire/`, intersect that footprint with an asset registry,
draft an evacuation advisory that cites its evidence, and stop at a draft until
a named human approves it.

Claude's role is interpretation, tool orchestration, and explanation. Claude
never computes a perimeter, an arrival time, a population figure, or a
confidence level; every such number comes from the model or the registry
through a tool and is read back. That boundary is the architectural rule the
rest of this entry serves, and it is `AGENTS.md`'s rule applied to an agent: an
LLM may interpret intent and explain results, and may not invent computed
metrics.

## The loop is the SDK tool runner, not a graph framework

The agent loop is `client.beta.messages.tool_runner` with `@beta_tool`-decorated
functions, on `claude-opus-5` with adaptive thinking. A graph framework such as
LangGraph was considered and rejected.

The work is a loop over tools we own. There is no branching topology to declare,
no human-in-the-loop checkpoint that needs to survive a process restart, and no
fan-out across agents. A graph library would add a dependency tree to a package
that otherwise needs exactly one direct dependency, and it would put an
abstraction between us and the Anthropic features the loop is built on —
adaptive thinking, prompt caching across turns, strict tool schemas — which are
the parts of the SDK we actually want unmediated. It would not help with either
hard part of this component. The hard parts are deciding exactly what the tool
boundary is, so the model cannot compute what the model must not compute, and
making the approval gate real rather than decorative. Both are our design work,
and a graph library has no opinion about either. The runner's per-turn hooks are
also the natural place for tool-call logging and refusal, which is where the
gate's enforcement surface belongs.

A run is bounded on both sides of that seam: `AgentConfig.max_turns` (default
24) is enforced by the package's own counter and by the runner's
`max_iterations`, so a watch cannot loop without end over a feed that keeps
returning detections. Refusal fallbacks are enabled by default
(`fallbacks="default"`) and can be switched off per deployment.

Revisit if the loop grows state that must outlive the process — resumable runs,
checkpoint-and-replay, scheduled watches that reconnect to work in flight — or
if several cooperating agents need a shared store and a declared topology. At
that point an orchestration layer earns its dependency. Also revisit if the
beta tool-runner surface churns enough within a major SDK version that pinning
it costs more than wrapping it.

## The fire model stays in TypeScript, behind a Node sidecar

Stage 3 drives the existing model in `app/src/fire/` through a Node stdio
sidecar (`agent/bridge/fire-bridge.mjs`, with `crisistwin_agent/simulation/bridge.py`
on the Python side). Rothermel is not ported to Python.

The alternative is a second implementation of the Scott & Burgan fuel table, the
Rothermel equations, the wind/slope vector combination, the Anderson
length-to-breadth relation, minimum-travel-time propagation, and marching-squares
contouring. Two copies of that would drift, and the invariants in ADR 0004 are
exactly the kind that drift silently: a Mercator metre is not a ground metre,
the ellipse is capped at 8:1, the effective wind limit is reported rather than
enforced, and a non-burnable ignition is refused instead of modelled. A Python
port that got any of those subtly wrong would disagree with the web app, and
neither owner would notice until the two were compared on the same scenario.
One physics implementation, one place to fix it.

The price is a process boundary and a Node prerequisite. The agent now needs
Node 22.15+ and a second small npm package under `agent/bridge/` to produce a
projection at all, scenario inputs and
per-frame GeoJSON cross stdio as serialized JSON, the sidecar has a lifecycle to
manage, and a failure on the far side arrives as a dead pipe that the Python
adapter has to turn back into a typed error rather than a missing projection.
That is an acceptable trade for not maintaining two copies of the physics.

Revisit if the fire model moves server-side behind an HTTP endpoint, in which
case the agent calls that endpoint and the sidecar disappears; if serialization
across the boundary becomes the run's bottleneck; or if Node stops being a
prerequisite elsewhere in the project, which would make the agent the only
reason to install it.

## Ports for every external dependency, failing explicitly

Every external dependency is a `Protocol` in `crisistwin_agent/ports.py`:
`DetectionSource`, `FireSpreadModel`, `ExposureModel`, `AdvisoryChannel`. The
tool layer depends on the protocols, not the adapters, so the offline fixture
source and the live FIRMS feed are interchangeable at the seam and the tools do
not change when one is swapped for the other.

Failure is explicit and typed. A port raises `PortUnavailableError` — carrying
the source and the reason — when it cannot answer at all, and `OutOfCoverageError`
when the request is outside a data product's valid domain, which for LANDFIRE
means outside the contiguous United States. No default is substituted for a
missing value anywhere in the package. The distinction that matters most is
between a source that answered and had nothing, which returns an empty list and
is a real result, and a source that could not answer, which raises. Conflating
them would let a missing API key read as "no fires detected", which is the worst
failure this component could have. The tool layer turns the exception into an
error tool result the model must account for, so the model reports what is
missing instead of reasoning over a quiet zero.

Revisit if the adapter set grows enough that constructing them by hand becomes
the awkward part, or if a port needs to be async because the loop starts
fetching several sources concurrently.

## Advisories are gated on a named human, and no channel reaches residents

`EvacuationAdvisory` is created as a `draft`. Only `approve(approver)` moves it
to `approved`, it refuses an empty approver, and an approved advisory without a
named approver fails construction. Every `AdvisoryChannel` must raise
`ApprovalRequiredError` for anything not approved. The protocol also carries a
`reaches_residents` flag, so the absence of a resident-facing channel is a
stated property of each channel rather than an accident of which ones happen to
exist; V1 ships only a channel that writes to the planner's review queue.

The gate is in the domain type rather than in the prompt because a prompt is not
an enforcement mechanism. The model drafts; it cannot approve, and it cannot
deliver. This follows `AGENTS.md` directly: simulated recommendations do not
become operational instructions, no resident alerts are sent, and no authority
approval is claimed without an explicitly authorized workflow. The standing
caveat in `EvacuationAdvisory.disclosure()` travels with every advisory surface
so the draft says what it is wherever it is displayed.

Revisit only with the responsible authority, under an explicitly authorized
workflow, with identified channels and accountable approvers. Adding a
resident-facing channel is a policy decision, not an engineering one, and
nothing in this package should make it a one-line change.

## A standalone package, not a Django app

`agent/` sits beside `app/`, not inside `app/backend/`. `app/backend/README.md`
already says future simulation calculations belong in a separate pure-Python
package with explicit inputs and outputs, importing neither Django nor provider
clients. The agent is a provider client and a simulation driver at once, so it
has even less business inside Django than the simulation code that rule was
written for. Keeping it out means the loop can be run, reasoned about, and
changed without a database, a web server, or a settings module, and the Django
API keeps its current shape: one unauthenticated health endpoint and no shared
scenario resources.

The costs are real. There is now a second Python dependency set — `agent/requirements.in`
and `agent/requirements.txt`, separate from the backend's — a second virtual
environment to create, and a small third npm manifest under `agent/bridge/` for
the sidecar. There is no HTTP endpoint, so nothing in `app/` can start
a watch run; the agent is a local process a person runs. And `agent/` depends on
`app/src/fire/` as source through the sidecar, a cross-directory dependency that
must stay one-directional: the fire model knows nothing about the agent.

One deviation from ADR 0001 is recorded here rather than left to be discovered.
That ADR has uv compile every Python lock. `agent/requirements.txt` was produced
by `pip freeze` instead, because neither uv nor Python 3.12 was installed on the
machine where the set was first resolved, and a hand-written file dressed up as
a uv lock would have been worse than an honest freeze. The file's header states
what it is, which interpreter and platform resolved it, what it loses relative
to a uv lock, and the exact `uv pip compile` command that should replace it. The
direct dependency set is one line: `anthropic>=2.3.0,<3`. Everything else the
package needs is standard library.

Revisit when planners need to start a watch from the web app. The answer then is
a thin Django adapter that calls into this package across its existing
boundaries — which is possible precisely because the package has them — not a
move of the loop into Django.

## Limits

The agent inherits every limit of the model it drives: surface fire only, no
crown fire, no spotting, no suppression, no structure-to-structure urban spread,
static and uniform weather, and LANDFIRE coverage limited to the contiguous
United States (ADR 0004). To those it adds its own. Satellite detections lag the
fire and are observations of heat in a pixel, not perimeters, so absence of
detections is not absence of fire. Clustering is a heuristic over pixel
positions, not a determination of how many fires exist. The asset registry is
invented: its neighborhoods, shelters, roads, and population estimates are
synthetic planning data, so every exposure figure an advisory quotes is a
property of that registry, and the offline detection fixture is hand-authored
rather than recorded, so an offline run observes nothing at all. No traffic or
evacuation-time modelling is wired in,
so a first-exposure minute is when the modelled fire reaches a modelled asset
and is neither a warning time nor a deadline.

Outputs remain planning experiments, not operational evacuation instructions.
