import SwiftUI
import WebKit

private enum MapLoadState: Equatable {
    case loading
    case loaded
    case failed(message: String)
}

/// The Practice tab: shows the web workspace's map page, so iOS reuses the web map and its
/// TypeScript fire model instead of running a second numerical model (ADR 0007, 0010).
struct ScenariosView: View {
    @State private var state: MapLoadState = .loading
    @State private var attempt = 0

    var body: some View {
        VStack(spacing: 0) {
            // One slim line instead of a title bar plus a two-line banner, so the map gets the space.
            // The tab bar already names the screen.
            Label("Practice only · not a forecast or evacuation order", systemImage: "flame")
                .font(.caption.weight(.medium))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal)
                .padding(.vertical, 6)
                .background(.orange.opacity(0.15))
            mapContent
                .frame(maxHeight: .infinity)
        }
        .background(Color("WorkspaceBackground"))
        .toolbar(.hidden, for: .navigationBar)
    }

    @ViewBuilder
    private var mapContent: some View {
        if let baseURL = try? AppConfiguration.webBaseURL() {
            ZStack {
                WebMapView(url: baseURL.appendingPathComponent("fire"), attempt: attempt, state: $state)
                    .opacity(state == .loaded ? 1 : 0)
                switch state {
                case .loading:
                    ProgressView("Loading the practice map…")
                case .loaded:
                    EmptyView()
                case .failed(let message):
                    ContentUnavailableView {
                        Label("Practice map unavailable", systemImage: "map")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Try again") {
                            state = .loading
                            attempt += 1
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }
            }
        } else {
            ContentUnavailableView(
                "Practice map unavailable",
                systemImage: "map",
                description: Text("Set a valid WEB_BASE_URL in the Xcode configuration. Release requires HTTPS.")
            )
        }
    }
}

/// Civilians only need the map and fire controls, so hide the web workspace's planner chrome:
/// the sidebar (logo, menu, planner links). The fire page's run warnings (`.fr-warnings` in
/// `app/src/fire/FireSimulatorPage.tsx`) stack over the map on a phone, so they collapse behind a
/// "Model notes (n)" chip: the model's limits stay one tap away instead of covering the fire.
/// This targets class names in `AppShell.tsx` and `FireSimulatorPage.tsx`; if they change, that
/// chrome and the warnings simply show again.
// ponytail: CSS injection from the app; switch to a web-side embed mode (e.g. `/fire?embed=1`) if this drifts.
private let practiceOnlyCSS = """
.skip-link, .sidebar { display: none !important; }
.app-layout { display: block !important; }
/* The page reserves the hidden sidebar header's height on phones; take the full screen instead. */
.fr-page { height: 100dvh !important; min-height: 0 !important; }
/* A tighter timeline dock leaves more of the screen to the simulation. */
.fr-dock { padding: 6px 10px !important; row-gap: 2px !important; }
.fr-speed-note { display: none !important; }
html:not(.ct-notes-open) .fr-warnings { display: none !important; }
.ct-notes-chip {
  position: fixed; left: 16px; bottom: 300px; z-index: 50; box-sizing: border-box;
  display: none; align-items: center; min-height: 44px; padding: 0 16px;
  border: 1px solid #e3d3a8; border-radius: 999px; background: #fbf3df; color: #5c4813;
  font: 600 14px/1 -apple-system, system-ui, sans-serif; box-shadow: 0 2px 8px rgba(0, 0, 0, .15);
}
.ct-notes-chip.has-notes { display: inline-flex; }
/* The board's "N" marker sits on the wind label on a phone; a compass at the side replaces it. */
.fdx-north { display: none !important; }
.ct-compass {
  position: fixed; right: 16px; z-index: 50; width: 44px; height: 44px; display: none;
  border: 1px solid rgba(60, 55, 50, .12); border-radius: 50%; background: rgba(251, 248, 241, .94);
  box-shadow: 0 2px 8px rgba(0, 0, 0, .15); pointer-events: none;
}
.ct-compass.is-shown { display: block; }
.ct-compass-needle {
  position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
  font: 700 12px/1 -apple-system, system-ui, sans-serif; color: #2a2e33;
}
.ct-compass-needle::before {
  content: ""; width: 0; height: 0; margin-bottom: 2px;
  border-left: 5px solid transparent; border-right: 5px solid transparent; border-bottom: 8px solid #d65a40;
}
"""

/// Adds the chip outside the page's React tree (so React never sees it) and keeps its count in step
/// with the warnings the page renders. Text only changes when it differs, so the observer settles.
/// The chip lines up with the page's Legend button (`.fr-legend-toggle`), falling back to a fixed offset,
/// and hides while the Scenario sheet (`.fr-scenario`) is open: the page's own layers can't cover it.
/// A compass sits at the right edge above Legend and turns with `data-north-deg`, the on-screen
/// direction of north that `FireDioramaScene.ts` publishes; it shows only while that value exists.
private let practiceNotesScript = """
(() => {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'ct-notes-chip';
  document.body.appendChild(chip);
  const compass = document.createElement('div');
  compass.className = 'ct-compass';
  compass.setAttribute('role', 'img');
  compass.innerHTML = '<div class="ct-compass-needle">N</div>';
  document.body.appendChild(compass);
  const needle = compass.firstChild;
  const sheetOpen = () => {
    const sheet = document.querySelector('.fr-scenario');
    return !!sheet && getComputedStyle(sheet).display !== 'none';
  };
  const sync = () => {
    const count = document.querySelectorAll('.fr-warnings li').length;
    const open = document.documentElement.classList.contains('ct-notes-open');
    const text = open ? 'Hide model notes' : '⚠ Model notes (' + count + ')';
    if (chip.textContent !== text) chip.textContent = text;
    chip.classList.toggle('has-notes', count > 0 && !sheetOpen());
    chip.setAttribute('aria-expanded', String(open));
    const legend = document.querySelector('.fr-legend-toggle');
    if (legend) {
      const box = legend.getBoundingClientRect();
      const bottom = Math.round(innerHeight - box.bottom) + 'px';
      const height = Math.round(box.height) + 'px';
      if (chip.style.bottom !== bottom) chip.style.bottom = bottom;
      if (chip.style.minHeight !== height) chip.style.minHeight = height;
      const above = Math.round(innerHeight - box.top + 12) + 'px';
      if (compass.style.bottom !== above) compass.style.bottom = above;
    }
    const heading = document.querySelector('[data-north-deg]')?.dataset.northDeg;
    compass.classList.toggle('is-shown', heading !== undefined && !sheetOpen());
    if (heading !== undefined) {
      const turn = 'rotate(' + heading + 'deg)';
      if (needle.style.transform !== turn) needle.style.transform = turn;
      const label = 'North is ' + (((Number(heading) % 360) + 360) % 360) + '° clockwise from the top of the screen';
      if (compass.getAttribute('aria-label') !== label) compass.setAttribute('aria-label', label);
    }
  };
  chip.addEventListener('click', () => {
    document.documentElement.classList.toggle('ct-notes-open');
    sync();
  });
  // The 3D labels restyle every frame, so coalesce to one check per frame and skip the chip's own edits.
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; sync(); });
  };
  new MutationObserver((records) => {
    if (records.some((record) => !chip.contains(record.target) && !compass.contains(record.target))) schedule();
  }).observe(document.body, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'data-north-deg'],
  });
  addEventListener('resize', schedule);
  sync();
})();
"""

private struct WebMapView: UIViewRepresentable {
    let url: URL
    let attempt: Int
    @Binding var state: MapLoadState

    func makeCoordinator() -> Coordinator { Coordinator(state: $state) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // ponytail: nothing persists between launches; switch to .default() if the web app adds sign-in.
        configuration.websiteDataStore = .nonPersistent()
        let style = "const s = document.createElement('style'); s.textContent = `\(practiceOnlyCSS)`; document.documentElement.appendChild(s);"
        for source in [style, practiceNotesScript] {
            configuration.userContentController.addUserScript(
                WKUserScript(source: source, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
            )
        }
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.state = $state
        guard context.coordinator.loadedAttempt != attempt else { return }
        context.coordinator.loadedAttempt = attempt
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10))
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var state: Binding<MapLoadState>
        var loadedAttempt: Int?

        init(state: Binding<MapLoadState>) { self.state = state }

        /// Stay on the practice map: links to the planner pages are not part of the civilian app.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
        ) {
            let isPracticeMap = navigationAction.request.url?.path == "/fire"
            decisionHandler(navigationAction.targetFrame?.isMainFrame == false || isPracticeMap ? .allow : .cancel)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationResponse: WKNavigationResponse,
            decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void
        ) {
            if let response = navigationResponse.response as? HTTPURLResponse, response.statusCode != 200 {
                state.wrappedValue = .failed(message: "The web app returned HTTP \(response.statusCode).")
                decisionHandler(.cancel)
            } else {
                decisionHandler(.allow)
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            state.wrappedValue = .loaded
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            fail(error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            fail(error)
        }

        private func fail(_ error: Error) {
            // A load replaced by a retry is cancelled, and a rejected HTTP status already set its own message.
            guard (error as NSError).code != NSURLErrorCancelled, state.wrappedValue == .loading else { return }
            state.wrappedValue = .failed(
                message: "Cannot reach the web app. Start it with docker compose in app/ and check WEB_BASE_URL."
            )
        }
    }
}
