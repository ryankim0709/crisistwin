import SwiftUI

/// What the app is, its limits, and the service readiness check (moved off Home for civilians).
@MainActor
struct AboutView: View {
    private enum ConnectionState {
        case loading
        case connected(version: String)
        case failed(message: String)
    }

    @State private var connection: ConnectionState = .loading
    @State private var attempt = 0

    var body: some View {
        List {
            Section {
                Text("CrisisTwin shows the one instruction for your zone during a wildfire and lets you report what you see.")
                    .font(.headline)
                    .fixedSize(horizontal: false, vertical: true)
                Text("The fire estimate is the latest observation or model fit, never a forecast. Meeting points are your own choices, not official shelters. Always follow evacuation orders from your local authorities.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Section("Service") {
                connectionContent
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("About")
        .task(id: attempt) {
            await loadHealth(requestID: attempt)
        }
    }

    @ViewBuilder
    private var connectionContent: some View {
        switch connection {
        case .loading:
            HStack(spacing: 12) {
                ProgressView()
                Text("Connecting")
            }
        case .connected(let version):
            LabeledContent {
                Text(version).monospacedDigit()
            } label: {
                Label("Connected", systemImage: "checkmark.circle")
            }
            Button("Check again") { retry() }
        case .failed(let message):
            Label("Connection unavailable", systemImage: "exclamationmark.triangle")
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Button("Try again") { retry() }
        }
    }

    private func retry() {
        connection = .loading
        attempt += 1
    }

    private func loadHealth(requestID: Int) async {
        guard !Task.isCancelled, requestID == attempt else { return }
        connection = .loading
        do {
            let client = APIClient(baseURL: try AppConfiguration.apiBaseURL())
            let health = try await client.fetchHealth()
            guard !Task.isCancelled, requestID == attempt else { return }
            connection = .connected(version: health.version)
        } catch {
            // SwiftUI cancels the request when this view disappears or a new attempt starts.
            guard !Task.isCancelled, requestID == attempt else { return }
            let message: String
            if let apiError = error as? APIError {
                message = apiError.localizedDescription
            } else if (error as? URLError)?.code == .timedOut {
                message = "The request timed out. Check that the API and database are running."
            } else {
                message = "Cannot reach the API. Check the server, network, and API_BASE_URL configuration."
            }
            connection = .failed(message: message)
        }
    }
}
