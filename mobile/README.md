# CrisisTwin for iOS

The civilian CrisisTwin app, for households planning ahead and during an
emergency; the web workspace serves planners (see
[ADR 0010](../docs/adr/0010-civilian-ios-app.md)). Its tabs are **Home**
(official-alerts status, one-tap actions, plan summary, and an About sheet with
the API readiness check), **My Plan**, and **Practice**. Native SwiftUI, targeting iPhone and iPad on
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

The Practice tab, under a "practice only, not a forecast" banner, shows only the
map and simulation: an injected stylesheet hides the web sidebar, and navigation
away from `/fire` is blocked. It shows the web app's `/fire` page (the Rothermel fire
spread model) in a `WKWebView`, so the map and the TypeScript fire model run unchanged (see
[ADR 0007](../docs/adr/0007-mobile-web-map.md)). `WEB_BASE_URL` is an origin like
`API_BASE_URL`, with the same validation; Debug uses `http://localhost:5173`, the
Vite server started by `docker compose up` in `app/`. The tab shows a loading
state, then the map, or an error with a retry button when the web app is not
reachable or returns a non-200 status. Nothing is stored between launches.

### My Plan

The My Plan tab holds a household meeting plan: a primary meeting point, an
optional backup, and trusted contacts (see
[ADR 0009](../docs/adr/0009-mobile-meeting-plan.md)). Points are chosen with
Apple Maps search or by tapping the map; contacts come from the system picker,
which needs no Contacts permission. The plan is saved only on the device as
versioned JSON and needs no backend. **Open in Maps** gives directions, and
sharing opens Messages for the contacts' numbers, or the share sheet where
Messages is unavailable, such as the simulator. The app never sends anything on
its own or reads the user's location.

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
    Networking/          Health DTO, HTTP client, and useful error messages
    Features/
      Home/              Civilian home and the About sheet with API readiness states
      Scenarios/         Practice tab: embedded web map with loading and error states
      Plan/              Meeting plan model and on-device store, plan tab, point editor
    Resources/           Info.plist and adaptive color assets
```

The workspace follows the web app's cream/green palette with dark-mode variants,
system text styles, labeled controls, and status icons accompanied by text.
The Practice tab embeds the web map. My Plan uses a native MapKit map for the
user's own meeting points. A Swift fire model, checking meeting points against
the simulation, traffic simulation, scenario storage/sync, authentication, and
notifications are not implemented. No fixtures or invented simulation metrics are displayed.

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

My Plan was run on the same simulator: Apple Maps search, tap-to-place, save,
reload after relaunch, the contact picker, and the share-sheet fallback were
exercised. Messages composing needs a physical device and was not checked.
