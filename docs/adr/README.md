# Architecture decision records

Parallel branches numbered ADRs independently, so numbers 0003 to 0013 and 0016 each appear more than once.
Files are not renumbered because code, docs and ADRs link to them by file name. **Always cite an
ADR by its full file name**, not by number alone. This index disambiguates them.

Status legend: **Accepted** is current. **Superseded** is kept for history; read the replacement.
**Partly superseded** still holds except where noted. **Proposed / In progress** is not fully implemented.

| File | Title | Status | Summary |
| ---- | ----- | ------ | ------- |
| [0001-app-scaffold](0001-app-scaffold.md) | Full stack app scaffold | Accepted | React/Vite/Tailwind frontend, Django REST backend, Docker; the stack and directory layout. |
| [0002-geographic-map](0002-geographic-map.md) | Reusable imagery map | Accepted | MapLibre map with cached USGS historical imagery (`app/public/map-preview`). |
| [0003-fire-spread-model](0003-fire-spread-model.md) | Fire spread simulator and demo spread model | **Superseded** by [0004-physics-fire-model](0004-physics-fire-model.md) | First `/fire` page and its demo model. |
| [0003-illustrative-fire-spread](0003-illustrative-fire-spread.md) | Illustrative wind-driven fire spread | **Superseded** | Geometric ellipse model in `app/src/simulation/fire.ts` for the old `/maps` page. That page and file were removed by [0015](0015-remove-overview-and-maps.md); the physics model replaced the approach. |
| [0004-mobile-swift-scaffold](0004-mobile-swift-scaffold.md) | Native SwiftUI mobile scaffold | Partly superseded by [0018-ios-26-baseline](0018-ios-26-baseline.md) | `mobile/` SwiftUI project; its iOS 17 / Xcode 16.2 version line no longer holds. |
| [0004-physics-fire-model](0004-physics-fire-model.md) | Physics- and vegetation-based fire spread model | Accepted (amended by [0007-wui-spread-mechanisms](0007-wui-spread-mechanisms.md)) | Rothermel surface spread on LANDFIRE fuels and terrain; supersedes 0003-fire-spread-model. |
| [0005-historical-incident-packages](0005-historical-incident-packages.md) | Versioned historical incident packages | Proposed; storage part superseded by [0006-incident-artifacts-in-mongodb](0006-incident-artifacts-in-mongodb.md) | Package format, provenance and offline replay semantics. |
| [0005-workspace-navigation](0005-workspace-navigation.md) | Shared workspace navigation | Partly superseded by [0015](0015-remove-overview-and-maps.md) | Sidebar shell and routes; the `/` overview and `/maps` parts are gone. |
| [0006-incident-artifacts-in-mongodb](0006-incident-artifacts-in-mongodb.md) | Incident package artifacts in MongoDB Atlas | Accepted | Raw and normalized bytes in GridFS keyed by SHA-256; manifests stay in Git. |
| [0006-planning-ui-scaffolds](0006-planning-ui-scaffolds.md) | Page-specific planning UI scaffolds | Accepted | Scenarios, evacuation, comparison, incidents and stress-test pages as local-state scaffolds. |
| [0007-mobile-web-map](0007-mobile-web-map.md) | Mobile scenarios reuse the web map | Partly superseded by [0015](0015-remove-overview-and-maps.md) and [0010-civilian-ios-app](0010-civilian-ios-app.md) | iOS embeds a web page in a `WKWebView`; it now embeds `/fire`, not `/maps`. |
| [0007-wui-spread-mechanisms](0007-wui-spread-mechanisms.md) | Wildland-urban interface spread mechanisms | Accepted | Ember spotting and structure-to-structure spread on top of the physics model. |
| [0008-crown-fire](0008-crown-fire.md) | Crown fire | Accepted | Van Wagner / Cruz / Scott and Reinhardt crown fire layer. |
| [0008-fire-watch-agent](0008-fire-watch-agent.md) | Fire watch agent | Accepted; implementation in progress | Agent in `agent/` that drafts advisories from fire observations. |
| [0008-mongodb-backend](0008-mongodb-backend.md) | MongoDB application backend | Accepted | PyMongo against Atlas replaces the SQL database. |
| [0009-mobile-meeting-plan](0009-mobile-meeting-plan.md) | Household meeting plan on iOS | Phase 1 implemented; later phases proposed | Civilian meeting-point plan in the iOS app. |
| [0009-solver-direction-set](0009-solver-direction-set.md) | Solver direction set | Accepted | Propagation directions used by the fire solver. |
| [0010-civilian-ios-app](0010-civilian-ios-app.md) | The iOS app is the civilian app | Accepted | iOS targets residents; the web workspace targets planners. |
| [0010-evacuation-diorama](0010-evacuation-diorama.md) | Fictional wildfire evacuation diorama | Accepted | `/diorama`: scripted, synthetic three.js evacuation of Larkspur Hollow. |
| [0011-fire-diorama-view](0011-fire-diorama-view.md) | Diorama view for the fire spread model | Accepted | three.js miniature as the default `/fire` view. |
| [0011-simulation-studio](0011-simulation-studio.md) | Simulation Studio and scheduled ignitions | Accepted | `/simulation`: up to five scheduled fires in one solver pass. |
| [0011-live-field-reports](0011-live-field-reports.md) | Live field reports and road status | Accepted; amended by [0012-controller-guidance](0012-controller-guidance.md) | Camp drill: civilian and responder reports become shared road and hazard status (`/api/live/…`, [contract](../live-reports.md)). |
| [0012-fire-large-areas](0012-fire-large-areas.md) | Large fire landscapes and long horizons | Accepted | Bigger boards and 24 h horizon. |
| [0012-controller-guidance](0012-controller-guidance.md) | Controller guidance in the live drill | Accepted | Planner computes per-zone guidance; a controller approves it on `/live`; pure reroutes publish automatically. |
| [0013-prebuilt-socal-landscapes](0013-prebuilt-socal-landscapes.md) | Prebuilt Southern California landscapes in MongoDB | Accepted | Station-scale regions served by `GET /api/landscapes`. |
| [0013-realtime-twin](0013-realtime-twin.md) | A resumable traffic engine for the real-time twin | Accepted | Steppable traffic engine behind the live twin and its what-if ([twin-api.md](../twin-api.md)). |
| [0014-dispatch-agent](0014-dispatch-agent.md) | Dispatch agent | Accepted | `/dispatch`: Claude agent orders evacuations and engines during playback. |
| [0015-remove-overview-and-maps](0015-remove-overview-and-maps.md) | Remove the overview and `/maps` pages | Accepted | `/` redirects to `/fire`; `/maps` is not-found. |
| [0016-resident-live-and-family](0016-resident-live-and-family.md) | Live simulation drill and families in the resident app | Accepted | iOS shows the planner's fire via `POST /api/live/broadcast`; families share meeting points. |
| [0017-dispatch-anywhere](0017-dispatch-anywhere.md) | Dispatch agent anywhere | Accepted | `/dispatch` on the 3D diorama for any area, with roads, stations and homes built at runtime. |
| [0018-road-closures](0018-road-closures.md) | Evacuation and road closures in the Studio 3D view | Accepted | Click roads or bridges closed; a fixed policy evacuates against the run with and without them. |
| [0019-live-dispatch-monitor](0019-live-dispatch-monitor.md) | Live dispatch monitor and staged waves | Accepted | `/dispatch` reattached on the Studio; a monitor wakes Claude only on change; zones evacuate in waves with simulated resident notices. |
| [0020-studio-firefighting](0020-studio-firefighting.md) | Firefighters and control lines in Simulation Studio | Accepted | Time-dependent control lines in the solver; a small search over anchor and line distance picks the best plan. |
| [0021-fire-path-scoped-evacuation](0021-fire-path-scoped-evacuation.md) | Evacuate only the fire path | Accepted | Zones get a simulator `impact` tier; the dispatcher never orders zones the fire is not forecast to reach. |
| [0022-dispatch-fire-attack](0022-dispatch-fire-attack.md) | Dispatched engines can attack a fire | Accepted | `attack_fire` with a simulator containment estimate; a fire put out is re-solved; the agent weighs attack against evacuation support. |
| [0023-studio-crew-dispatch](0023-studio-crew-dispatch.md) | Firefighters drive in from fire stations | Accepted | Crews leave OSM fire stations at report time, drive the road graph and walk in; their arrivals drive the firefighting model and the board. |
| [0024-studio-crews-assist-evacuation](0024-studio-crews-assist-evacuation.md) | Overwhelmed Studio crews help the evacuation | Accepted | When direct attack cannot put the fire out, crews leave after a size-up and go on evacuation support in the busiest threatened zones. |
| [0025-dispatch-fire-tactics](0025-dispatch-fire-tactics.md) | The dispatcher chooses how to fight each fire | Accepted | Direct, flank or indirect attack with solved what-ifs; structure fires attackable; control lines judged at fire arrival. |
| [0018-ios-26-baseline](0018-ios-26-baseline.md) | iOS 26 baseline for the phone app | Accepted | Deployment target 26.0, Xcode 26; tab app with Liquid Glass and no `#available` branches. |
