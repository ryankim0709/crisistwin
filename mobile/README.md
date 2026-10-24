# CrisisTwin for iOS

The civilian CrisisTwin app, for households planning ahead and during an
emergency; the web workspace serves planners (see
[ADR 0010](../docs/adr/0010-civilian-ios-app.md)). It is one screen about the
live incident (see **Live** below), with no tab bar; **My Plan**, **Family**, My reports,
responder join, the **Web simulation** feed and About sit behind one menu button. Native SwiftUI, targeting iPhone and iPad on
**iOS 17.0+**. Use **Xcode 16.2+** with its bundled Swift compiler in **Swift 5
language mode**. Only Apple frameworks are used. There is no package install or
project generation step; Swift Package Manager is the choice for future Swift
dependencies. No `Package.resolved` exists because there are no package dependencies.

## Start development

From the repository root:

```sh
open mobile/CrisisTwin.xcodeproj
```

Select the shared **CrisisTwin** scheme, choose an iPhone or iPad simulator running
iOS 17 or newer, and choose **Product > Run** (`Cmd-R`). Install an iOS simulator
runtime through Xcode settings if none is available. Simulator development does
not need a signing team. The app opens without a backend; the connection card
shows an error and a retry button when the API is unavailable.

To use the readiness card with the existing local stack, from the repository root:

```sh
cd app
docker compose up --build --wait
```

Debug connects directly to `http://localhost:8000/api/health` from the simulator.
It does not use Vite's proxy. Running this command starts the existing web stack;
the scaffold makes no backend or database changes.

## Configuration

`Config/Debug.xcconfig` supplies `API_BASE_URL`, an origin with no path (for example,
`http://localhost:8000`). The client appends `/api/health`. Empty values, embedded
credentials, query strings, fragments, invalid ports, and non-root paths are
rejected. HTTPS is supported in all configurations. Debug also permits HTTP for
`localhost` and `.local` hostnames. Local networking is declared in `Info.plist`;
there is no global arbitrary-load exception. See Apple's
[local networking setting](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking).

For optional local Debug overrides, from the repository root:

```sh
cp mobile/Config/Local.xcconfig.example mobile/Config/Local.xcconfig
```

Edit that ignored file. Preserve the `http:/$()/` or `https:/$()/` notation: the
empty expansion prevents `//` from being parsed as an xcconfig comment. Do not
put credentials in build settings; values are embedded in the app bundle.

For a physical device, select your development team in Xcode's **Signing &
Capabilities**, set a unique bundle identifier if needed, and use an HTTPS API or
your Mac's `.local` hostname instead of `localhost`. Both devices must be on a
reachable network, and iOS must allow local network access. The backend must
listen on a reachable interface and include the hostname in `DJANGO_ALLOWED_HOSTS`
(see [`app/.env.example`](../app/.env.example)). This scaffold does not change
backend binding, firewall rules, or allowed hosts. The existing Compose setup
publishes port 8000 only on `127.0.0.1`, so changing the mobile hostname alone is
not enough for a physical device. Plain HTTP IP addresses are intentionally not
accepted by the mobile configuration.

### Practice map

The Practice view was removed from the phone. It showed the web app's `/fire` page in a
`WKWebView` with the sidebar hidden (see [ADR 0007](../docs/adr/0007-mobile-web-map.md)).
`WEB_BASE_URL` is still validated like `API_BASE_URL`; Debug uses `http://localhost:5173`.

### My Plan

My Plan, in the menu, holds a household meeting plan: a primary meeting point, an
optional backup, and trusted contacts (see
[ADR 0009](../docs/adr/0009-mobile-meeting-plan.md)). Points are chosen with
Apple Maps search or by tapping the map; contacts come from the system picker,
which needs no Contacts permission. The plan is saved only on the device as
versioned JSON and needs no backend. **Open in Maps** gives directions, and
sharing opens Messages for the contacts' numbers, or the share sheet where
Messages is unavailable, such as the simulator. The app never sends anything on
its own, and My Plan never reads the user's location.

### Live

The app opens on the live incident, a drill replaying the 2018 Camp Fire on the
real Camp road network (see [ADR 0011](../docs/adr/0011-live-field-reports.md),
[ADR 0012](../docs/adr/0012-controller-guidance.md) and the
[API contract](../docs/live-reports.md)). A full-screen map shows your position,
the current fire estimate (labeled with its method and drill time, never a
forecast), confirmed hazards and your route. The top strip shows your zone and
its guidance level. One bottom sheet holds the single instruction for your zone,
such as "Be ready to leave, Via Skyway → Exit south, 26 min", with **I'm out**
and **Need help** check-ins. Responders see their assigned task there. Guidance
is per zone and is approved by a controller on the web (`/live`), or published
automatically for a pure reroute around a confirmed block or fire.

The phone polls `GET /api/live/incidents/camp-2018-drill/situation` and finds
its zone on the device, so a civilian's location leaves the phone only inside a
report or a **Need help** check-in. Responders can opt in to sharing their latest
position. **Report what you see** (the floating button) saves reports on the
device first and sends them when the network allows. Credentials are kept in the
Keychain and the unsent queue in `Application Support/live-outbox.json`. To run
it locally, start the backend and drill as described in
[`app/backend/README.md`](../app/backend/README.md); Debug points at
`http://localhost:8000`.

### Web simulation (menu)

Shows, natively in MapKit, the simulation a planner is playing on the web `/fire` or
`/dispatch` page with **Share with resident app** on (see
[ADR 0016](../docs/adr/0016-resident-live-and-family.md)). The app polls `GET /api/live`
every 3 seconds while the screen is open and draws the simulated fire, the household's home and
meeting points, and, while the dispatch agent runs, the household's zone, its assigned exit
and route. The guidance card says what the simulation tells that zone: no order yet, leave
now, wait about N minutes (the route is backed up and the fire is far), route blocked, zone
evacuated, or fire in the zone, and "route changed" when the agent redirects it. Meeting
points the simulated fire reaches are marked and the first clear one is offered. Set a home
location on that screen; it stays on the phone, and the zone is worked out locally. A banner
says it is a simulation drill, not an emergency service. Needs the Docker stack and a web
page broadcasting.

### Family

Create a family or join one with its 8-character code. Members share one primary and
backup meeting point and post a status (safe, on the way, at meeting point, need help);
no location is shared. Meeting points are edited in My Plan and synced to the family; a
change by another member replaces the points on this phone. The membership token is kept in
the Keychain; the family refreshes every 10 seconds in the foreground. Contract:
[ADR 0016](../docs/adr/0016-resident-live-and-family.md).

Release does not include `Local.xcconfig` and has empty `API_BASE_URL` and `WEB_BASE_URL`. Set an
HTTPS origin in the Release configuration before distribution. Until then the
app shows a configuration error instead of claiming connectivity. App Store
icons, signing/provisioning, and distribution are not configured.

## Structure and boundaries

```text
mobile/
  CrisisTwin.xcodeproj/   Checked-in project and shared run/archive scheme
  Config/                Debug, Release, and ignored local overrides
  CrisisTwin/
    App/                 SwiftUI app entry point and tab navigation
    Configuration/       Validated API and web origins from the app bundle
    Networking/          Health, live-report and JSON backend HTTP clients, Keychain credentials
    Features/
      Home/              The About sheet with API readiness states
      Plan/              Meeting plan model and on-device store, plan tab, point editor
      Live/              Field-report models, store, outbox, location, map, report and responder views
      Broadcast/         Web simulation feed: broadcast model, poller, map and household guidance
      Family/            Family model, Keychain membership, server store, family view
    Resources/           Info.plist and adaptive color assets
```

The workspace follows the web app's cream/green palette with dark-mode variants,
system text styles, labeled controls, and status icons accompanied by text.
The Practice tab embeds the web map. My Plan and Live drill use native MapKit maps.
Live drill checks meeting points against the broadcast fire; there is no Swift fire model.
Push notifications, user accounts beyond family tokens, and per-incident broadcasts are not
implemented. No fixtures or invented simulation metrics are displayed.

### Health boundary

`APIClient.fetchHealth()` reads the existing unauthenticated `GET /api/health`
contract with `Accept: application/json` and returns `HealthResponse` only after
validating the status, service, and nonempty version. No server contract changes.

```json
{"status": "ok", "service": "crisistwin-api", "version": "0.1.0"}
```

HTTP 200 plus the body above means the API's database probe succeeded. HTTP 503
with `status: "unavailable"`, the same service, and a nonempty version produces a
database-unavailable message. Other HTTP statuses, malformed bodies, timeouts,
and connection failures produce errors. This is a readiness check, with no
coordinates, units, observation timestamps, or simulation results. Full contract:
[`app/backend/README.md`](../app/backend/README.md).

Requests use an ephemeral session without a URL cache, a 10-second request and
resource timeout, and manual retry only. The view owns its task through SwiftUI's
`.task(id:)`; cancellation and request identity checks prevent obsolete responses
from changing the current state. The success label describes the last check,
not continuously monitored health.

## Verification

From the repository root, the only default check is:

```sh
pre-commit run --all-files
```

No tests, lint, type checks, builds, simulator/device runs, or browser verification
are part of the default agent workflow. They require an explicit user request.
The embedded map was built with Xcode 26.6 and run on an iOS 26.5 simulator. Its
loading, error and retry states were checked, and the then-current `/maps` page from
`docker compose up` rendered with its fire controls. The tab now loads `/fire`
instead; that has not been run on a simulator. It has not been checked on a
physical device.

Live drill and Family have not been built or run; the new backend endpoints have not been
exercised.

My Plan was run on the same simulator: Apple Maps search, tap-to-place, save,
reload after relaunch, the contact picker, and the share-sheet fallback were
exercised. Messages composing needs a physical device and was not checked.
