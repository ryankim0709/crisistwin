import SwiftUI
import WebKit

private enum MapLoadState: Equatable {
    case loading
    case loaded
    case failed(message: String)
}

/// Shows the web workspace's map page, so iOS reuses the web map and its
/// TypeScript fire model instead of running a second numerical model (ADR 0006).
struct ScenariosView: View {
    @State private var state: MapLoadState = .loading
    @State private var attempt = 0

    var body: some View {
        Group {
            if let baseURL = try? AppConfiguration.webBaseURL() {
                ZStack {
                    WebMapView(url: baseURL.appendingPathComponent("maps"), attempt: attempt, state: $state)
                        .opacity(state == .loaded ? 1 : 0)
                    switch state {
                    case .loading:
                        ProgressView("Loading the web map…")
                    case .loaded:
                        EmptyView()
                    case .failed(let message):
                        ContentUnavailableView {
                            Label("Map unavailable", systemImage: "map")
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
                    "Map unavailable",
                    systemImage: "map",
                    description: Text("Set a valid WEB_BASE_URL in the Xcode configuration. Release requires HTTPS.")
                )
            }
        }
        .background(Color("WorkspaceBackground"))
        .navigationTitle("Scenarios")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct WebMapView: UIViewRepresentable {
    let url: URL
    let attempt: Int
    @Binding var state: MapLoadState

    func makeCoordinator() -> Coordinator { Coordinator(state: $state) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // ponytail: nothing persists between launches; switch to .default() if the web app adds sign-in.
        configuration.websiteDataStore = .nonPersistent()
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
