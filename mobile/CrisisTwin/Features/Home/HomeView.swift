import SwiftUI

@MainActor
struct HomeView: View {
    private enum ConnectionState {
        case loading
        case connected(version: String)
        case failed(message: String)
    }

    @State private var connection: ConnectionState = .loading
    @State private var attempt = 0

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                Text("CAL HACKS / MOBILE PROTOTYPE")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)

                Text("A place to test what happens next.")
                    .font(.largeTitle.bold())

                Text("Explore how wildfire, road closures, and evacuation decisions interact.")
                    .foregroundStyle(.secondary)

                VStack(alignment: .leading, spacing: 16) {
                    Label("System connection", systemImage: "network")
                        .font(.headline)
                    connectionContent
                    Text("Readiness only. No live incident or simulation data is loaded.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
                .background(.background, in: RoundedRectangle(cornerRadius: 16))

                VStack(alignment: .leading, spacing: 8) {
                    Text("Your mobile workspace")
                        .font(.headline)
                    Text("Map simulation is available in the web app. Native maps and shared scenarios are not connected yet.")
                        .foregroundStyle(.secondary)
                }

                Text("Experimental planning only. Outputs are not operational evacuation instructions.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding(24)
            .frame(maxWidth: 640, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(Color("WorkspaceBackground"))
        .navigationTitle("CrisisTwin")
        .task(id: attempt) {
            await loadHealth(requestID: attempt)
        }
    }

    @ViewBuilder
    private var connectionContent: some View {
        switch connection {
        case .loading:
            ProgressView("Connecting to the API…")
        case .connected(let version):
            Label("API and database connected", systemImage: "checkmark.circle")
            Text("Version \(version) · last check succeeded")
                .font(.caption)
                .foregroundStyle(.secondary)
            Button("Check again") { retry() }
                .buttonStyle(.bordered)
        case .failed(let message):
            Label("Connection unavailable", systemImage: "exclamationmark.triangle")
            Text(message)
                .font(.subheadline)
            Button("Try again") { retry() }
                .buttonStyle(.borderedProminent)
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
