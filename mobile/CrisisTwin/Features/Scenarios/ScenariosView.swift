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
            Label("Practice only: a simulated fire from a simple model, not a forecast or an evacuation order.", systemImage: "flame")
                .font(.footnote)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal)
                .padding(.vertical, 10)
                .background(.orange.opacity(0.15))
            mapContent
                .frame(maxHeight: .infinity)
        }
        .background(Color("WorkspaceBackground"))
        .navigationTitle("Practice")
        .navigationBarTitleDisplayMode(.inline)
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
/// the sidebar (logo, menu, planner links). This targets class names in `app/src/AppShell.tsx`;
/// if they change, that chrome simply shows again.
// ponytail: CSS injection from the app; switch to a web-side embed mode (e.g. `/fire?embed=1`) if this drifts.
private let practiceOnlyCSS = """
.skip-link, .sidebar { display: none !important; }
.app-layout { display: block !important; }
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
