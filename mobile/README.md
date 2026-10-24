# CrisisTwin for iOS

Native SwiftUI counterpart to the web workspace, targeting iPhone and iPad on
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

Release does not include `Local.xcconfig` and has an empty `API_BASE_URL`. Set an
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
    Configuration/       Validated API origin from the app bundle
    Networking/          Health DTO, HTTP client, and useful error messages
    Features/
      Home/              Workspace and API readiness states
      Scenarios/         Explicit empty state for future scenario integration
    Resources/           Info.plist and adaptive color assets
```

The workspace follows the web app's cream/green palette with dark-mode variants,
system text styles, labeled controls, and status icons accompanied by text.
The Scenarios tab is a placeholder. Native maps, fire/traffic simulation,
scenario storage/sync, authentication, and notifications are not implemented.
No fixtures or invented simulation metrics are displayed. Keep future numerical
models separate from SwiftUI and networking; the web's TypeScript model has not
been ported to Swift.

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
This scaffold has not been compiled or run in Xcode. The run instructions above
are for developer setup, not a claim of runtime verification.
