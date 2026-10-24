# 0004: Native SwiftUI mobile scaffold

Date: 2026-10-23. Status: accepted for the initial mobile scaffold; the iOS 17+ / Xcode 16.2+ version line is superseded by [0018-ios-26-baseline](0018-ios-26-baseline.md).

Add an independent iOS app under `mobile/`, using SwiftUI and Foundation on
iOS 17+, Xcode 16.2+, and Swift 5 language mode. Check in the Xcode project and a
shared scheme so teammates can open it without project generators. Use Apple
frameworks only for this scaffold; future Swift packages use Swift Package
Manager and its committed resolved lockfile. There are no dependencies to lock
today. Existing npm/pip dependencies and the web/backend structure are unchanged.

The first increment mirrors the web workspace's branding and API readiness card,
with native navigation and an explicit scenario empty state. It does not port
the web map or illustrative TypeScript fire model, add a second numerical model,
or define speculative scenario APIs. A later mobile map/simulation change must
choose and document how model contracts are shared without divergent results.

Keep feature UI, bundle configuration, and HTTP adapters in separate folders.
The only server integration is the existing `GET /api/health` readiness contract.
Validate configuration and decoded values, cap request duration at ten seconds,
avoid cached readiness, and suppress canceled/stale responses. No automatic
retry loop, persistence, authentication flow, location collection, or external
service is introduced.

Debug defaults to the simulator's `localhost:8000`; ignored xcconfig overrides
support individual developer setups. HTTP is limited by application validation
to localhost and `.local` names in Debug. Release requires HTTPS and starts with
no endpoint configured rather than inventing a production service. Local-network
ATS permission supports development, without globally disabling ATS.

This keeps setup small and provides a native iPhone/iPad foundation, at the cost
of a separate UI implementation and no initial web simulation parity. App Store
assets, provisioning, deployment, and mobile runtime verification are deferred.
Follow the repository's pre-commit-only default verification policy.
