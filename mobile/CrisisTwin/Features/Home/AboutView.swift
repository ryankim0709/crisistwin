import SwiftUI

/// What the app is, its limits, and the service readiness check (moved off Home for civilians).
@MainActor
struct AboutView: View {
    private enum ConnectionState {
        case loading
        case connected(version: String)
        case failed(message: String)
    }

    @Environment(\.dismiss) private var dismiss
    @State private var connection: ConnectionState = .loading
    @State private var attempt = 0

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("CrisisTwin shows the one instruction for your zone during a wildfire and lets you report what you see.")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Color.ctInk)
                    .fixedSize(horizontal: false, vertical: true)

                Label {
                    Text("This is a drill on the 2018 Camp Fire road network, not a real incident. The fire estimate is the latest observation or model fit, never a forecast. Meeting points are your own choices, not official shelters. Always follow evacuation orders from your local authorities.")
                        .foregroundStyle(Color.ctInk)
                        .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "exclamationmark.shield")
                        .foregroundStyle(HazardTone.caution.color)
                }
                .font(.subheadline)
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(HazardTone.caution.color.opacity(0.1), in: RoundedRectangle(cornerRadius: 16, style: .continuous))

                VStack(alignment: .leading, spacing: 14) {
                    Label("System connection", systemImage: "network")
                        .font(.headline)
                        .foregroundStyle(Color.ctInk)
                    connectionContent
                }
                .ctCard()
            }
            .padding(20)
            .frame(maxWidth: 640, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(Color.ctBackground)
        .navigationTitle("About")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }
            }
        }
        .task(id: attempt) {
            await loadHealth(requestID: attempt)
        }
    }

    @ViewBuilder
    private var connectionContent: some View {
        switch connection {
        case .loading:
            ProgressView("Connecting to the API…")
                .tint(Color.ctBrand)
                .foregroundStyle(Color.ctMuted)
        case .connected(let version):
            StatusPill(text: "API and database connected", systemImage: "checkmark.circle", tone: .clear)
            Text("Version \(version)")
                .font(.caption)
                .foregroundStyle(Color.ctMuted)
            Button("Check again") { retry() }
                .buttonStyle(SecondaryButtonStyle())
        case .failed(let message):
            StatusPill(text: "Connection unavailable", systemImage: "exclamationmark.triangle", tone: .caution)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(Color.ctInk)
            Button("Try again") { retry() }
                .buttonStyle(PrimaryButtonStyle())
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
