# Integration TODO

Status as of 2026-10-24. What remains to connect the pieces built in this round into one system:
any California fire as the one active live drill, fed by generated and real ground data, driven
by a human or an orchestrator agent over MCP, and scored. Design: [ADR 0030](adr/0030-scenario-engine.md).

Legend: **[wip]** an agent is building it now, **[ready]** built and merged on `feat/live-replay-sim`
but not wired, unmarked = not started. Items are in dependency order within each section.

## 0. Land what is built

- [ ] Merge `feat/live-replay-sim` to `main` (16 branches: console at peak, calibration, planner
      congestion, AAR + score, live feeds, multi-phone hosting, iOS QA + XCUITest, Studio drill
      packages, MCP server + event stream, simulated responders, residents, comms generator,
      injects, evaluation protocol, comms-infra data, weather, suppression data).
- [ ] Merge the current wave when each lands: active incident **[wip]**, suppression engine
      **[wip]**, adversarial data + truth log **[wip]**, batch runner **[wip]**, task board **[wip]**,
      people data **[wip]**, load test **[wip]**.
- [ ] Clean up: `.claude/worktrees/`, merged `feat/*` and `worktree-agent-*` branches, QA tasks
      left in the dev drill DB (`crisistwin_live_dev`).

## 1. One active incident, everywhere

- [ ] **[wip]** Active incident switch: per-incident drill index, `GET/POST /api/live/active`,
      console "Drill" switcher, phones follow, MCP defaults to the active incident.
- [ ] Twin for packages: build `TwinInputs` from a package's roads, synthetic zones and fire
      timeline (today the twin is Camp-only); demand from synthetic homes, labelled.
- [ ] Make every incident-scoped feature incident-aware: ground record (Camp-only file),
      response record, injects, AAR (the "vs 2018" component only for historical incidents;
      re-weight otherwise), planner congestion, responder routing, task board.
- [ ] Studio → live: "Use as live drill" → "Activate" end to end in a browser, on a non-Camp area
      with a real OpenStreetMap build (only mocked so far).
- [ ] Docker parity: the backend container mounts only `app/backend`, so `tools/` (ground record),
      `app/public/replays/` (bundles) and `LIVE_PACKAGES_DIR` are missing there. Add mounts or
      settings and test `docker compose up` with `/live`.

## 2. Scenario → live data (generators wired to the drill)

- [x] A scenario spec (package + window + injects + generator params + noise profile + seed)
      shared by live drills and the batch runner (the batch runner **[wip]** defines it; reuse it).
- [x] `live_run_scenario`: one process that ticks the generators against the active incident
      on the drill clock, so a watched drill fills itself.
- [x] Comms generator → queue: `groundrecord.materialize_due` labels everything
      `historical_record`; add a `simulated` path for `sim/gen_comms.py` output (same queue
      rules, same controller-only points).
- [x] Residents → live: a driver that posts or inserts `sim/gen_residents.py` events (reports,
      check-ins, help, destination choices); `offered=` from live guidance.
- [ ] Responders: wire the `silent_closure` inject into `World.truth_blocked`; give simulated
      responders server-side congestion (responder tokens cannot read the twin).
- [ ] **[wip]** Noise layer and hidden truth log over all generated streams; the truth log is never
      readable by the console, phones or MCP.
- [x] Injects ↔ generators: `psap_reroute` and `comms_outage` windows applied to generated comms
      and residents (helpers exist in `livecore/injects.py`).

## 3. Calibration fixes before trusting generated data

- [x] Residents' help rate is about 10x the Camp rescue rate and 3.4x the scaled 911 bound:
      sweep `help_at_home_per_h` against `sim/ground_rates.py` targets.
- [ ] Comms generator: radio burstiness (dispersion 1.9 vs 3.5) needs a within-zone burst
      process; rescue-to-911 binding 24-28% vs 43%. Bursts done (radio refit dispersion 3.63 vs
      3.53, `comms.bursts`); binding is still short (0.22 with bursts).
- [ ] Validate generators against Camp end to end (the "D" check): generated Camp vs the 2018
      record on timing, rates and category mix, many seeds.
- [ ] **[wip]** People data (R1) into `sim/behavior.py` and `gen_residents` (departure delays,
      compliance, shadow evacuation, no-vehicle households, care facilities, schools). Done behind
      `twin.people` and in `gen_residents`: departure delays, compliance, shadow evacuation,
      no-vehicle households ([live scenario runner](live-scenario-runner.md)); facilities and schools open.
- [ ] Comms-infra data into a tower-failure model (sites fail with fire exposure; battery life;
      72 h rule after 2021) driving `comms_outage` automatically; alert reach (CodeRED 55% / 7%).
      Tower model done (`sim/comms_towers.py`, uncalibrated, posted live by `live_run_scenario`);
      alert reach open.
- [ ] Scenario weather: `sim/weather.py` is not consumed by Studio or the fire model yet;
      wire `scenario_wind` into Studio and convert 10 m / 20 ft heights.
- [ ] Planner hysteresis: congestion-aware planning changes destinations ~3.4x as often with no
      measured benefit on one seed; tune margin/dwell/smoothing with multi-seed runs.

## 4. Firefighting

- [ ] **[wip]** Suppression engine: sourced rates, road access R01-R12 per apparatus class,
      helicopters and airtankers with daylight, wind and turnaround limits, first-alarm preset.
- [ ] Use the CAL FIRE bases in the live drill: simulated responders start at real stations
      instead of the four approximate Chico points.
- [ ] Licence decisions for local-only data: `tools/ca_fire_bases.json` (CAL FIRE layer, no open
      licence) and `tools/people_facilities_butte_fixture.json` (CDPH, CDSS, CDE "Terms of Use" or
      none). Ask the agencies or use other datasets.
- [ ] A Camp-day population extract: the ACS fixture is 2018-2022 on 2020 block groups, so it
      does not describe Paradise before the fire and won't join the Camp package; ACS 2014-2018
      needs a Census API key (keyless requests were refused).
- [ ] Suppression in the live drill: today it lives in Studio (browser); the live fire is a
      timeline. Decide whether live drills get suppression (crews changing the fire) or stay
      replay-only for fire.

## 5. Strategy evaluation and the orchestrator agent

- [ ] **[wip]** Batch runner: scenario x strategy x seed, built-in strategies, `mcp_agent` adapter,
      AAR scoring in drill minutes, pilot on Camp.
- [ ] Twin random stream per entity, so paired strategies on the same seed don't diverge by
      chance (the protocol depends on it).
- [ ] MCP for the teammate's agent:
  - [ ] trim `get_situation` (31-41 KB per call);
  - [ ] hide 2018 order times from MCP tools in evaluated runs (they leak the "vs 2018" score);
  - [ ] record `agent:<name>` on proposal decisions (`decided_by` is still `controller`);
  - [ ] note that `get_situation` can trigger auto-replan.
- [ ] Hand-off to the teammate: a runnable example (MCP config + a scenario + the batch runner),
      and agree on the prompt/tool A/B protocol in `docs/strategy-evaluation.md`.

## 6. Crowdsourcing and live UX

- [ ] **[wip]** Task board, passive auto-completion (opt-in), information priority, "Stale and
      critical" on the console.
- [ ] Console checks never run in a browser: responder routes on the map, the Invite phones
      dialog, injects map marks, live feeds panel, AAR page against a long drill.
- [ ] iOS:
  - [ ] QR join on a physical device;
  - [ ] Home check-in buttons below the fold under an active order;
  - [ ] fire-trend line and guidance-change banner never observed;
  - [ ] rerun all four XCUITests after the layout fixes;
  - [ ] Release `API_BASE_URL` (HTTPS).
- [ ] Live feeds (NWS, Caltrans, WFIGS) stay on real-world time: confirmed feed candidates do
      not affect routing; decide whether `/live` shows a real-world panel or they stay on `/intel`.

## 7. Multi-phone hosting

- [ ] Run a real multi-phone drill: same Wi-Fi with `CT_BIND_ADDR=0.0.0.0` and `<mac>.local`,
      then an HTTPS tunnel; console on the Mac, 3+ phones joined by QR.
- [ ] Always set `LIVE_CONTROLLER_TOKEN` for multi-phone use (otherwise every request is the
      controller; a LAN client could forge `Host`).
- [ ] **[wip]** Load test: results and any fixes (caching `situation` per drill tick, gzip, ETags).

## 8. Repo hygiene

- [ ] Flaky full-suite test: `test_replan_congestion.test_published_route_is_the_incumbent`
      fails only in the full run (shared state); find and isolate. The `live_drills already
      exists` race is fixed.
- [ ] Test databases per run (agents and people collided on `crisistwin_live_test`).
- [ ] Docs: `docs/adr/README.md` index is gone and numbers repeat; AGENTS.md still says to add
      ADRs to the index. Update AGENTS.md, and decide numbering going forward.
      `docs/live-reports.md` is very long; split by area (reports, guidance, help, injects, AAR,
      events, tasks).
- [ ] README route table and component list for everything added (`/live/report`, MCP, batch,
      generators, data tools).
- [ ] Existing ESLint `react-refresh/only-export-components` errors in `src/live`.
