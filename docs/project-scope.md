# CrisisTwin — Cal Hacks 13.0 Project Scope

> Planning scope: the features and integrations below are proposed work, not a
> statement of implemented functionality or verified prize eligibility. Suggested
> technologies do not supersede the current stack in the [README](../README.md)
> and [accepted scaffold decision](adr/0001-app-scaffold.md).

**Team:** 3 developers
**Goal:** Build an interactive disaster simulation and AI-powered evacuation planning platform with a working technical core and multiple meaningful sponsor integrations.

## 1. Project Overview

CrisisTwin is an AI-powered disaster simulation and evacuation planning platform that allows emergency responders to simulate natural disasters, stress-test response plans, and optimize population-wide evacuations.

Users interact with a digital twin of a geographic area where they can initiate wildfires, change wind conditions, close roads or bridges, simulate congestion, and evaluate alternative evacuation strategies.

An AI decision-support system helps interpret real-world public information, generate counterfactual scenarios, investigate plan vulnerabilities, and explain simulation results.

**Core differentiators:**

- Population-wide traffic and evacuation modeling
- Interactive disaster and infrastructure disruptions
- Autonomous AI stress testing
- Identification of critical missing information
- Real-world incident intelligence through Apify
- Transparent comparison of alternative response strategies

All predictions and outcomes in the hackathon prototype are experimental simulations, not operational evacuation guidance.

---

# PART I — FULL-STACK ENGINEERING

## 2. Interactive Geographic Digital Twin

**Priority: MVP — P0**

### Frontend requirements

- Display a real geographic region, initially Berkeley Hills.
- Import road and intersection geometry.
- Show neighborhoods, evacuation origins, roads, and shelters.
- Support zooming, panning, and selecting locations.
- Animate fire spread and traffic movement.
- Display changing congestion and threatened infrastructure.
- Let users configure scenarios and inspect results.
- Provide a simulation timeline with playback controls.

### Interactive controls

- Click to start a simulated wildfire.
- Adjust wind direction and speed.
- Click roads and bridges to close or reopen them.
- Change shelter capacity.
- Change evacuation participation and departure timing.
- Pause, resume, reset, or rerun simulations.

### Suggested technologies

- Next.js + React + TypeScript
- Tailwind CSS
- MapLibre GL JS or Mapbox
- Deck.gl for advanced map visualization (stretch)

**Visual stretch:** Animated 3D terrain, realistic smoke effects, and moving vehicle icons.

## 3. Wildfire Simulation Engine

**Priority: MVP — P0**

Simulate wildfire propagation across a geographic grid.

### Requirements

- Select an ignition point.
- Track the fire's progression over time.
- Incorporate wind speed and direction.
- Incorporate simplified vegetation/fuel effects.
- Export the simulated fire perimeter.
- Calculate approximate hazard arrival times at road segments.

### Technology

- Python
- SimFire or custom cellular automaton
- NumPy
- Optional: terrain and fuel datasets

### Important integration

The fire engine must produce structured outputs that the traffic engine can consume.

For example, when a road segment intersects the simulated fire hazard, the system can mark it as unavailable under a defined closure rule.

This is where wildfire behavior begins affecting evacuation outcomes.

## 4. Traffic and Population Simulation

**Priority: MVP — P0**

Model entire populations evacuating rather than calculating isolated shortest paths.

### Requirements

- Import a road network.
- Define neighborhood population and vehicle demand.
- Simulate vehicles entering the network over time.
- Model road capacity, queues, and congestion.
- Support multiple evacuation routes and destinations.
- Allow roads to become unavailable during simulation.
- Calculate modeled evacuation metrics.

### Scenarios

- Everyone leaves simultaneously.
- Neighborhoods evacuate in scheduled waves.
- One major bridge becomes inaccessible.
- Multiple roads become congested.
- A shelter reaches capacity.

### Suggested technologies

- UXsim for congestion simulation
- OSMnx for road networks
- NetworkX for graph operations

**Key output:** Demonstrate that changing road availability or departure schedules produces measurable changes in traffic and evacuation results.

## 5. Evacuation Optimization Engine

**Priority: MVP — P0/P1**

Build an optimization layer that searches for better evacuation strategies.

### Decision variables

- Neighborhood departure windows
- Route assignments
- Shelter allocations
- Distribution of vehicles across available roads

### Objectives

- Reduce evacuation clearance time.
- Minimize congestion and total delay.
- Reduce modeled hazard exposure.
- Respect shelter and roadway capacity.
- Minimize the number of people unable to evacuate.

### Implementation

- Python heuristics or OR-Tools
- Candidate-plan generation
- Repeatable simulation runs
- Explicit optimization constraints

The optimizer generates strategies and evaluates them using the traffic and fire simulators.

**Important:** An LLM should not calculate travel times or invent optimal routes. Numerical outcomes must come from the simulation.

## 6. Backend and Data Infrastructure

**Priority: MVP — P0**

### Suggested stack

- FastAPI
- Python
- Scenario data storage
- WebSockets or event streaming as needed

### Responsibilities

- Manage disaster scenarios.
- Launch simulation runs.
- Apply changes to environment and infrastructure.
- Coordinate fire and traffic simulations.
- Run optimization jobs.
- Store and retrieve outcomes.
- Expose tools to the AI system.
- Stream status and results to the frontend.

### Suggested API operations

- `create_scenario`
- `ignite_fire`
- `update_weather`
- `close_road`
- `set_shelter_capacity`
- `run_simulation`
- `optimize_evacuation`
- `compare_scenarios`
- `get_simulation_metrics`

### [SPONSOR: CONVEX] Real-Time Command Center

**Priority: P1**

Use Convex as the reactive state layer for a collaborative emergency planning environment.

Features:

- Synchronize incident reports across users.
- Share road closures and scenario updates.
- Track simulation runs and generated results.
- Allow multiple planners to view the same command center.
- Display new incident intelligence as it arrives.

**Sponsor value:** Convex powers important real-time collaboration and shared simulation state—not just an unused database table.

Alternative: SpacetimeDB, but choose one for the hackathon.

---

# PART II — AI FEATURES

## 7. AI Scenario Controller

**Priority: MVP — P1**

**[SPONSOR: ANTHROPIC]**

Users control the simulator through natural language.

### Example commands

- "Simulate a fire starting in the Berkeley Hills."
- "What happens if this bridge collapses?"
- "Increase wind speed by 20%."
- "Close the eastern evacuation route."
- "Try evacuating neighborhoods in three waves."
- "Optimize evacuation after this road closure."

### Implementation

1. Claude interprets the user's instruction.
2. It selects an appropriate backend tool.
3. It generates validated structured parameters.
4. The simulation engine executes the change.
5. The AI analyzes the resulting metrics.

The model must not modify the map or simulator arbitrarily outside the available tools.

## 8. [NEW AI] Real-World Incident Intelligence Agent

**Priority: P1 — Primary Apify integration**

**[SPONSOR: APIFY] [SPONSOR: ANTHROPIC]**

Create an AI agent that continuously or on demand retrieves public emergency information relevant to a selected geographic region.

### Potential information sources

- Public agency incident pages
- Official road closure announcements
- Public emergency alerts
- Published evacuation notices
- Public transportation service disruptions
- Weather-related safety announcements

Prefer official APIs where available. Use Apify where extracting information from public webpages is genuinely necessary.

### Apify's role

Create a dedicated **CrisisTwin Incident Intelligence Actor** that:

1. Crawls selected public sources.
2. Detects relevant incident and road-status information.
3. Extracts timestamps and original source URLs.
4. Normalizes the extracted information into structured records.
5. Handles missing or malformed page content.
6. Sends results to the CrisisTwin backend.

Creating a reusable custom Actor also creates a possible entry for Apify's **Best Actor** category.

### AI's role

Claude takes the collected public information and:

- Categorizes incident types.
- Identifies roads, locations, and infrastructure mentioned.
- Extracts relevant conditions and timestamps.
- Identifies contradictions between different reports.
- Flags ambiguous or outdated information.
- Suggests which reports may warrant a new scenario.

### Example

Apify finds an official public statement indicating a road is closed.

Claude produces:

- Incident: Road closure
- Location: Identified street segment
- Source: Original public announcement
- Reported timestamp: Extracted from the notice
- Verification status: Unconfirmed in CrisisTwin

The planner reviews the proposed road-network mapping.

After confirmation, CrisisTwin creates a new simulation scenario with that road disabled and compares evacuation outcomes.

### Why this matters

Removing Apify would eliminate a meaningful source of external incident intelligence.

The integration directly changes the scenarios the system can investigate instead of merely decorating the dashboard with scraped news.

**Demo requirement:** Show at least one real public-source extraction and its transformation into an inspectable scenario. Don't invent a current incident to make the live integration appear successful.

## 9. [NEW AI] Autonomous Disaster Red-Team Agent

**Priority: P1/P2**

**[SPONSOR: ANTHROPIC]**
**[POTENTIAL: MICROSOFT, TECHNICAL COMPLEXITY]**

Create an AI agent that attempts to uncover vulnerabilities in evacuation plans.

### Capabilities

- Select critical road segments for testing.
- Generate plausible infrastructure-disruption scenarios.
- Adjust simulated weather parameters.
- Test reduced shelter capacity.
- Test reduced transportation availability.
- Identify scenarios with poor evacuation performance.

### Example

A baseline plan evacuates the modeled population successfully.

The agent independently tests several road closures and discovers that closing one specific bridge dramatically increases clearance time.

The agent then reports:

- Which scenario caused the failure
- Which neighborhoods are affected
- Which metrics worsened
- Which alternative strategies perform better

### Implementation

The agent proposes counterfactual scenarios through tool calls. The simulation engine performs the calculations.

To control runtime, limit the initial search to perhaps 10–20 candidate failures.

**Demo opportunity:** Let judges manually close a road, then ask the AI to discover an even more disruptive failure.

## 10. [NEW AI] Value-of-Information Agent

**Priority: P2 — High-value stretch**

**[SPONSOR: ANTHROPIC]**
**[POTENTIAL: TECHNICAL COMPLEXITY, MICROSOFT]**

Determine which unknown facts responders should investigate before making decisions.

### Examples of uncertainties

- Whether a bridge is open
- Whether a shelter has remaining capacity
- Whether a particular road is blocked
- Whether evacuation vehicles are available
- Whether a reported incident is still active

### Workflow

1. Identify a decision-relevant unknown.
2. Generate plausible possible states.
3. Simulate the alternatives.
4. Compare the best decisions and resulting outcomes.
5. Estimate the value of resolving the uncertainty.
6. Rank facts that responders should verify.

### Example

If a bridge is open, strategy A performs best.

If the bridge is closed, strategy B performs best.

The system recognizes that verifying the bridge's condition could change the preferred plan and creates a high-priority information request.

**Important:** The actual value-of-information calculation should be algorithmic. Claude identifies candidate questions and explains why the modeled uncertainty matters.

## 11. [NEW AI] Multi-Agent Emergency Planning System

**Priority: P2 — Stretch**

Create specialized AI agents with separate responsibilities.

### Agent A — Incident Intelligence

Uses Apify-derived information to identify relevant external reports and unresolved questions.

### Agent B — Scenario Designer

Creates counterfactual situations and determines which simulations to run.

### Agent C — Evacuation Analyst

Calls optimization tools and compares candidate evacuation plans.

### Agent D — Risk Auditor

Reviews assumptions, checks simulation results for inconsistencies, and identifies plans that fail under plausible disruptions.

### Agent E — Incident Briefing

Compiles the results into a structured, source-linked summary for planners.

**Potential prize alignment:**

- Anthropic
- Microsoft
- Most Technically Complex
- Creao AI-First Disruptor, subject to its specific participation requirements

### Implementation recommendation

These can initially be separate tool-driven roles using the same underlying Claude model rather than five independent continuously running agents.

Prioritize observable behavior and reliable execution over the number of agents.

## 12. [NEW AI] Explainable Decision Reports

**Priority: P1**

**[SPONSOR: MICROSOFT AWARD ALIGNMENT] [SPONSOR: ANTHROPIC]**

Automatically explain simulation results in an understandable, auditable format.

### Report contents

- Scenario description
- Baseline performance
- Alternative strategies tested
- Changes in congestion
- Changes in evacuation clearance time
- Unmet transportation needs
- Potential hazard exposure
- Critical infrastructure vulnerabilities
- Sources of external incident data
- Uncertainties and limitations

### Example

"The modeled closure of Road A increased evacuation clearance time relative to the baseline. Staggering departures reduced the simulated bottleneck, but delayed departures increased potential exposure in Neighborhood B."

The AI should cite simulator outputs and data-source records and never fabricate numerical results.

**Microsoft alignment:** This feature helps establish measurable usefulness, decision traceability, human oversight, and a plausible path from prototype to production. It does not require pretending the system is already operationally validated.

## 13. [NEW AI] Conversational Voice Command Center

**Priority: P3 — Optional stretch**

**[SPONSOR: CARTESIA]**

Make CrisisTwin usable through voice during a tabletop emergency-response exercise.

### Features

- Spoken scenario modifications
- Natural back-and-forth discussion about simulation results
- Interruption support
- Spoken incident briefings
- Voice-driven testing of alternative plans

### Demo

A judge says:

"What happens if the main evacuation bridge closes?"

The agent confirms the intended bridge, executes a sandbox simulation, and explains the modeled outcome aloud.

**Sponsor requirement:** Cartesia must be central to a genuinely useful voice interaction, not merely read a text report aloud. Don't prioritize this until the main simulator works.

## 14. [NEW AI] Inclusive Evacuation and Assistance Agent

**Priority: P2 — High-impact stretch**

**[POTENTIAL: META, PEOPLE-FIRST, MICROSOFT]**

Help planners recognize and model residents with additional evacuation requirements.

### Populations

- Residents without vehicles
- Wheelchair users
- Older adults requiring assistance
- Care-facility residents
- Households needing shared transportation

### Capabilities

- Estimate unmet transport demand.
- Assign limited accessible vehicles.
- Identify neighborhoods with insufficient evacuation capacity.
- Compare plans using both efficiency and accessibility metrics.
- Explain who remains underserved.

### Meta-oriented extension

Add a two-way coordination workflow where residents can voluntarily submit assistance needs, and planners can review aggregated information.

AI helps convert reports into actionable, privacy-conscious requests.

This is substantially stronger for Meta's human-connection theme than simply building a chatbot.

For the hackathon, use fictional resident profiles and simulated requests. Any future real deployment would require robust privacy controls and participation by emergency authorities.

## 15. [NEW AI] Controlled Autonomous Operations

**Priority: P3 — Optional Factory / Atlassian integration**

### [SPONSOR: FACTORY]

Use Factory Droid SDK to perform a real, bounded task initiated from CrisisTwin.

Possible feature: **Scenario Validation Agent**.

When a planner saves a new evacuation policy or custom simulation rule, Droid can:

- Generate a validation test for that rule in a sandbox repository.
- Execute the test against the simulator.
- Detect invalid constraints or inconsistent results.
- Produce an audit log and code/test diff.
- Request approval before applying changes.

This is only worthwhile if Droid actually performs this work at runtime. Using Droid to write CrisisTwin's code during the hackathon is not sufficient for Factory's prize.

### [SPONSOR: ATLASSIAN]

A more operational extension is a native Forge app that turns verified incident-planning findings into structured Jira workflows.

Features:

- Create and assign information-verification tasks.
- Track unresolved infrastructure status.
- Associate tasks with source evidence.
- Record approvals and scenario decisions.

A standard Jira API integration alone would not satisfy the described Atlassian challenge; this needs a meaningful Forge app.

**Recommendation:** Do not build both integrations unless the MVP and higher-priority sponsor features are already complete.

---

# PART III — ADDITIONAL STRETCH FEATURES

## 16. Live Environmental Data

**Priority: P2/P3**

Potential sources:

- National Weather Service — weather and alerts
- NASA FIRMS — satellite fire detections
- USGS — terrain
- LANDFIRE — fuel and vegetation
- Official local road closure information

Keep live observations separate from simulated fire propagation and hypothetical scenario events.

NASA FIRMS detections are not equivalent to a precise fire perimeter or a road closure.

## 17. Additional Disaster Scenarios

**Priority: Post-MVP**

Potential extensions:

- Flooding
- Earthquakes
- Infrastructure failures
- Multiple simultaneous hazards

Avoid implementing additional disaster models during the core hackathon unless the wildfire system is already finished.

## 18. Planner Collaboration

**Priority: P2**

Using Convex:

- Multiple planners join a scenario.
- Planners share proposed road closures.
- Agents post findings to a shared incident board.
- Planners compare strategies.
- Approved changes synchronize in real time.

## 19. Civilian Information Portal

**Priority: P3 / Post-hackathon**

A separate interface that displays official, authority-approved emergency information and accepts voluntary assistance requests.

The platform must not automatically publish experimental routing results as real evacuation instructions.

---

# PART IV — SPONSOR PRIZE STRATEGY

## 20. Primary Sponsor Targets

| Sponsor / Award | Relevant CrisisTwin Feature | Priority |
|---|---|---|
| Apify — Best Use | Public emergency intelligence Actor powering scenario updates | High |
| Apify — Best Actor | Custom reusable incident-data collection and normalization Actor | High |
| Anthropic | Agentic scenario control, red teaming, explanation, and uncertainty analysis | High |
| Convex | Collaborative real-time command center and reactive scenario state | High |
| Microsoft — Built for the Real World | Useful, reliable, human-reviewed emergency-planning workflow | High |
| Cal Hacks — People-First | Inclusive population-wide evacuation planning | High |
| Cal Hacks — Technical Complexity | Coupled fire/traffic simulation and optimization | High |
| Cal Hacks — Overall | Fully functional integrated product with an excellent demo | High |

## 21. Secondary Sponsor Targets

| Sponsor / Award | Additional Requirement |
|---|---|
| Meta | Real, AI-mediated human coordination and communication |
| Cartesia | Voice must be an essential part of the workflow |
| Factory | Runtime Droid SDK execution of meaningful work |
| Atlassian | Native Forge app for collaborative operations or agent governance |
| Creao AI | Verify track-specific requirements; demonstrate meaningful AI-first functionality |
| Bright Data | Alternative public-web data pipeline in place of Apify |
| MLH Best Use of Gen AI | Functional and distinctive generative AI capability |
| MLH Commit Fellowship | Working prototype, founder-oriented application and supplemental form |
| Most Creative Hack | Compelling, interactive disaster stress-testing experience |
| Best Planet-First Hack | Environmental resilience and disaster-preparedness impact |

Prizes are potential targets, not guaranteed qualification. Reconfirm submission rules and any restrictions on entering multiple sponsor tracks.

---

# PART V — TECHNICAL ARCHITECTURE

## 22. Proposed Full Architecture

```text
                  CRISISTWIN FRONTEND
              Next.js / React / MapLibre
                           |
             +-------------+-------------+
             |                           |
       Map + Simulation UI       AI Command Interface
             |                           |
             v                           v
                FASTAPI BACKEND
                       |
    +------------------+-------------------+
    |                  |                   |
    v                  v                   v
Fire Simulation   Traffic Simulation   Claude Agent
SimFire / CA      UXsim + OSMnx        Orchestrator
    |                  |                   |
    +---------+--------+          +--------+------+
              |                   |               |
              v                   v               v
      Evacuation Optimizer   Stress Testing   Explanation
      OR-Tools / Heuristics  + Uncertainty    + Reports
              |                   |
              +---------+---------+
                        |
                        v
                  SCENARIO RESULTS
                        |
              +---------+---------+
              |                   |
              v                   v
         Convex State       Incident Intelligence
         Live Sync          Apify Actor + Claude
                                  |
                                  v
                        Public Web Information
```

### Architectural rules

1. Fire propagation is computed by a model, not by an LLM.
2. Traffic congestion and travel times are computed by the traffic simulator.
3. Optimization uses measurable simulator outputs.
4. AI interprets requests, coordinates tools, tests alternatives, and explains results.
5. Public data is labeled with source, timestamps, and verification status.
6. Unverified reports do not automatically trigger real-world actions.
7. All simulated outcomes remain clearly separated from actual emergency guidance.

---

# PART VI — THREE-PERSON TEAM PLAN

## 23. Developer Responsibilities

### Developer 1 — Frontend and Visualization

**Primary:**

- Map and geographic layers
- Fire and traffic rendering
- Road/bridge closure interface
- Simulation timeline
- Baseline versus optimized comparison

**Secondary:**

- Convex live-state integration
- Collaborative incident dashboard
- Voice interaction UI if time permits

### Developer 2 — Simulation and Optimization

**Primary:**

- Fire propagation
- Road network extraction
- Traffic simulation
- Road-capacity and closure mechanics
- Evacuation optimization

**Secondary:**

- Automated stress-test execution
- Value-of-information calculations
- Vulnerable-population modeling

### Developer 3 — AI, Backend, and Integrations

**Primary:**

- FastAPI
- Claude tool-calling orchestration
- Apify Actor
- Incident intelligence and data normalization
- Natural-language scenarios
- Result explanations

**Secondary:**

- Autonomous red-team agent
- Incident reports
- Other sponsor integrations

### Shared responsibility

Every developer owns their integration testing. The team should agree on simulation input and output schemas before building independently.

---

# PART VII — IMPLEMENTATION PRIORITIES

## 24. P0 — Non-Negotiable Core

- [ ] Interactive road-network map
- [ ] Simulated wildfire spread
- [ ] Manual bridge/road closures
- [ ] Capacity-aware traffic simulation
- [ ] Population evacuation simulation
- [ ] Alternative evacuation strategies
- [ ] Optimization producing computed results
- [ ] Side-by-side comparison of results

**Success:** Closing a road causes the traffic model to change, and the optimizer finds and evaluates an alternative strategy.

## 25. P1 — Main Sponsor and AI Features

- [ ] Claude natural-language simulator controls
- [ ] AI-generated explanations grounded in results
- [ ] Apify public incident ingestion
- [ ] Custom CrisisTwin Apify Actor
- [ ] Evidence-linked incident review
- [ ] Convex shared scenario and incident state
- [ ] Autonomous red-team testing of selected failures

**Success:** A real public-source observation can become a reviewed hypothetical simulation change, and the AI can explain the resulting trade-offs.

## 26. P2 — High-Value Stretch Goals

- [ ] Value-of-information analysis
- [ ] Vulnerable-population modeling
- [ ] Multi-agent orchestration
- [ ] AI-generated incident reports
- [ ] Additional live weather and fire observations
- [ ] Multi-user planner collaboration
- [ ] Assisted transportation allocation

## 27. P3 — Optional Sponsor Extensions

- [ ] Cartesia voice command center
- [ ] Meta-oriented responder/resident coordination
- [ ] Factory runtime validation agent
- [ ] Atlassian Forge incident workflow
- [ ] Advanced 3D maps and effects
- [ ] Additional disaster types

---

# PART VIII — TARGET DEMO

## 28. Ideal Three-Minute Hackathon Demo

**0:00–0:25 — Introduce the problem**

Show a simulated wildfire approaching neighborhoods on a real road map.

Explain that conventional individual routing does not automatically coordinate thousands of residents competing for limited road capacity.

**0:25–0:55 — Simulate a baseline evacuation**

Start the traffic simulation.

Show vehicles departing, congestion forming, and the modeled evacuation clearance time.

**0:55–1:20 — Break the infrastructure**

Have a judge close a road or bridge.

The simulator recalculates congestion and evacuation performance.

**1:20–1:50 — Optimize the response**

Ask Claude to test alternative evacuation strategies.

The backend compares the results and visualizes the best-performing candidate.

**1:50–2:15 — Demonstrate Apify incident intelligence**

Trigger or show a successful live Actor run retrieving a genuine public incident-related record.

Display its source, timestamp, extracted details, and review status.

Show how it can be converted into a new hypothetical scenario.

**2:15–2:40 — AI stress testing**

Run an autonomous test of additional failures.

Highlight a newly discovered bottleneck or vulnerability and explain why it matters.

**2:40–3:00 — Final impact**

Show before/after metrics, summarize the human-review safeguards, and explain how CrisisTwin helps planners identify vulnerabilities before acting.

If the live data source has no relevant current incidents, show that transparently rather than fabricate an incident.

---

## 29. Final Vision

CrisisTwin is not just a wildfire visualization application.

It is an **AI-powered disaster planning and decision-intelligence platform** that combines mathematical simulation, infrastructure modeling, real-world information gathering, and autonomous stress testing.

The hackathon goal is to demonstrate that planners can:

1. Create an emergency scenario.
2. Observe how wildfire and traffic conditions interact.
3. Introduce unexpected infrastructure failures.
4. Optimize alternative evacuation strategies.
5. Investigate relevant public reports.
6. Have AI autonomously discover weaknesses and explain trade-offs.

**Our strongest demonstration is the complete loop: simulate → disrupt → measure → optimize → stress-test → explain.**
