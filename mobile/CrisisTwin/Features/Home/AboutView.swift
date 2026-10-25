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
        ScrollView {
            VStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("CrisisTwin shows the one instruction for your zone during a wildfire and lets you report what you see.")
                        .font(.ctTitle)
                        .foregroundStyle(Color.ctInk)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("The fire estimate is the latest observation or model fit, never a forecast. Meeting points are your own choices, not official shelters. Always follow evacuation orders from your local authorities.")
                        .font(.subheadline)
                        .foregroundStyle(Color.ctInkMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .ctPanel()

                VStack(alignment: .leading, spacing: 12) {
                    PlanCardHeader("Service")
                    connectionContent
                }
                .ctPanel()

                ProfileCard()

                ServerSettingsCard { retry() }
            }
            .ctScreenPadding()
        }
        .ctScreenBackground()
        .navigationTitle("About")
        .navigationBarTitleDisplayMode(.inline)
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
                    .foregroundStyle(Color.ctInkMuted)
            }
            .frame(minHeight: 44)
        case .connected(let version):
            HStack(spacing: 12) {
                Label("Connected", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(Color.ctSuccess)
                Spacer(minLength: 8)
                Text(version)
                    .font(.subheadline)
                    .foregroundStyle(Color.ctInkMuted)
                    .monospacedDigit()
            }
            .frame(minHeight: 44)
            .accessibilityElement(children: .combine)
            Button("Check again") { retry() }
                .buttonStyle(PlanPillStyle(kind: .secondary, fullWidth: true))
        case .failed(let message):
            Label("Connection unavailable", systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(Color.ctWarning)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(Color.ctInkMuted)
                .fixedSize(horizontal: false, vertical: true)
            Button("Try again") { retry() }
                .buttonStyle(PlanPillStyle(kind: .secondary, fullWidth: true))
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

/// Nickname, kind and location sharing for the drill's controller. Short on purpose.
@MainActor
private struct ProfileCard: View {
    @Environment(LiveStore.self) private var store
    @Environment(LocationProvider.self) private var location

    var body: some View {
        @Bindable var store = store
        VStack(alignment: .leading, spacing: 12) {
            PlanCardHeader("You")
            TextField("Name (optional)", text: $store.displayName)
                .textInputAutocapitalization(.words)
                .submitLabel(.done)
                .onSubmit { store.syncProfile() }
                .onChange(of: store.displayName) { _, name in
                    if name.count > 24 { store.displayName = String(name.prefix(24)) }
                }
                .frame(minHeight: 44)
            Picker("I am", selection: kindBinding) {
                ForEach(ParticipantKind.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            Toggle("Share my location", isOn: $store.shareResponderLocation)
                .tint(Color.ctBrand)
                .frame(minHeight: 44)
            if store.shareResponderLocation, !location.isAuthorized, location.authorization != .notDetermined {
                Text("Location is off for this app.")
                    .font(.subheadline)
                    .foregroundStyle(Color.ctInkMuted)
            }
        }
        .font(.subheadline)
        .foregroundStyle(Color.ctInk)
        .ctPanel()
        .onDisappear { store.syncProfile() }
    }

    private var kindBinding: Binding<ParticipantKind> {
        Binding(
            get: { store.participantKind ?? (store.role == .responder ? .firefighter : .resident) },
            set: { store.participantKind = $0; store.syncProfile() })
    }
}

/// Shown once when the phone first joins: nickname, kind and location consent.
@MainActor
struct FirstJoinSheet: View {
    @Environment(LiveStore.self) private var store
    @Environment(LocationProvider.self) private var location
    @State private var name = ""
    @State private var kind: ParticipantKind?

    private var automatic: ParticipantKind { store.role == .responder ? .firefighter : .resident }
    private var selected: ParticipantKind { kind ?? automatic }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("What should we call you?").font(.ctTitle)
                    TextField("Name (optional)", text: $name)
                        .textInputAutocapitalization(.words)
                        .padding(12)
                        .background(Color.ctBrandSoft, in: .rect(cornerRadius: 12))
                        .onChange(of: name) { _, value in
                            if value.count > 24 { name = String(value.prefix(24)) }
                        }
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("I'm a…").font(.ctTitle)
                    Picker("I'm a", selection: Binding(get: { selected }, set: { kind = $0 })) {
                        ForEach(ParticipantKind.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("Share my location with the drill?").font(.ctTitle)
                    Text("So the controller can see where people are.")
                        .font(.subheadline)
                        .foregroundStyle(Color.ctInkMuted)
                    HStack(spacing: 12) {
                        Button("Not now") { finish(share: false) }
                            .buttonStyle(FieldPill(minHeight: 50))
                        Button("Yes") {
                            location.requestPermission()
                            finish(share: true)
                        }
                        .buttonStyle(FieldPill(primary: true, minHeight: 50))
                    }
                }
                Button("Skip") { finish(share: false, skip: true) }
                    .font(.subheadline)
                    .foregroundStyle(Color.ctInkMuted)
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .foregroundStyle(Color.ctInk)
            .ctScreenPadding()
            .padding(.top, 24)
        }
        .ctScreenBackground()
        .presentationDetents([.large])
    }

    private func finish(share: Bool, skip: Bool = false) {
        store.completeProfileSetup(name: skip ? "" : name, kind: skip ? automatic : selected, shareLocation: share)
    }
}
