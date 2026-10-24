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
            practiceBanner
            mapContent
                .frame(maxHeight: .infinity)
        }
        .background(Color.ctBackground)
        .navigationTitle("Practice")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// Always visible above the map, so the simulation is never mistaken for a forecast or an order.
    private var practiceBanner: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "flame.fill")
                .foregroundStyle(HazardTone.caution.color)
                .accessibilityHidden(true)
            Text("Practice only: a simulated fire from a simple model, not a forecast or an evacuation order.")
                .foregroundStyle(Color.ctInk)
        }
        .font(.footnote.weight(.medium))
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(HazardTone.caution.color.opacity(0.12))
        .overlay(alignment: .bottom) {
            Rectangle().fill(HazardTone.caution.color.opacity(0.35)).frame(height: 1)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var mapContent: some View {
        if let baseURL = try? AppConfiguration.webBaseURL() {
            ZStack {
                WebMapView(url: baseURL.appendingPathComponent("maps"), attempt: attempt, state: $state)
                    .opacity(state == .loaded ? 1 : 0)
                switch state {
                case .loading:
                    ProgressView("Loading the practice map…")
                        .tint(Color.ctBrand)
                        .foregroundStyle(Color.ctMuted)
                case .loaded:
                    EmptyView()
                case .failed(let message):
                    UnavailableCard(message: message) {
                        Button {
                            state = .loading
                            attempt += 1
                        } label: {
                            Label("Try again", systemImage: "arrow.clockwise")
                        }
                        .buttonStyle(PrimaryButtonStyle())
                    }
                }
            }
        } else {
            UnavailableCard(message: "Set a valid WEB_BASE_URL in the Xcode configuration. Release requires HTTPS.") {
                EmptyView()
            }
        }
    }
}

/// Explains why the practice map is missing, with an optional retry, in a centered card.
private struct UnavailableCard<Actions: View>: View {
    let message: String
    @ViewBuilder let actions: Actions

    @ScaledMetric(relativeTo: .title) private var badge: CGFloat = 64

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Image(systemName: "map")
                    .font(.title.weight(.semibold))
                    .foregroundStyle(Color.ctBrand)
                    .frame(width: badge, height: badge)
                    .background(Color.ctBrand.opacity(0.1), in: Circle())
                    .accessibilityHidden(true)
                VStack(spacing: 6) {
                    Text("Practice map unavailable")
                        .font(.title3.bold())
                        .foregroundStyle(Color.ctInk)
                    Text(message)
                        .font(.subheadline)
                        .foregroundStyle(Color.ctMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .multilineTextAlignment(.center)
                actions
                    .padding(.top, 4)
            }
            .ctCard(padding: 24)
            .padding(20)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
        .defaultScrollAnchor(.center)
    }
}

/// Civilians only need the map and fire controls, so hide the web workspace's planner chrome:
/// the sidebar (logo, menu, planner links) and the planning-tools panel. This targets class names in
/// `app/src/AppShell.tsx` and `MapsPage.tsx`; if they change, that chrome simply shows again.
// ponytail: CSS injection from the app; switch to a web-side embed mode (e.g. `/maps?embed=1`) if this drifts.
private let practiceOnlyCSS = """
.skip-link, .sidebar, .map-planning-tools { display: none !important; }
.app-layout { display: block !important; }
.app-content .map-page { height: 100dvh !important; }
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
        configuration.userContentController.addUserScript(
            WKUserScript(source: style, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        )
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
            let isPracticeMap = navigationAction.request.url?.path == "/maps"
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
