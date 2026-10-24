import SwiftUI

/// The menu sheet behind the incident screen's one menu button: My reports, Responder (join or
/// leave, share location), My plan and About. Reads `LiveStore` from the environment.
struct AppMenu: View {
    init() {}

    private enum Destination: String, Hashable {
        case myreports, responder, plan, about
    }

    @Environment(LiveStore.self) private var store
    @Environment(\.incidentActions) private var actions
    @Environment(\.dismiss) private var dismiss
    @State private var path: [Destination] = DebugLaunch.screen.flatMap(Destination.init(rawValue:)).map { [$0] } ?? []

    var body: some View {
        @Bindable var store = store
        NavigationStack(path: $path) {
            List {
                Section {
                    NavigationLink(value: Destination.myreports) {
                        HStack {
                            Label("My reports", systemImage: "list.bullet.rectangle")
                            Spacer()
                            if !store.pending.isEmpty {
                                StatusPill(text: "\(store.pending.count) waiting", systemImage: "tray.and.arrow.up", tone: .caution)
                            }
                        }
                    }
                    NavigationLink(value: Destination.plan) {
                        Label("My plan", systemImage: "figure.2")
                    }
                }
                Section {
                    NavigationLink(value: Destination.responder) {
                        Label(store.role == .civilian ? "Join as responder" : "Responder tasks",
                              systemImage: "person.badge.shield.checkmark")
                    }
                    if store.role != .civilian {
                        Toggle(isOn: $store.shareResponderLocation) {
                            Label("Share my location", systemImage: "location.fill")
                        }
                    }
                }
                Section {
                    NavigationLink(value: Destination.about) {
                        Label("About", systemImage: "info.circle")
                    }
                }
            }
            .foregroundStyle(Color.ctInk)
            .scrollContentBackground(.hidden)
            .background(Color.ctBackground)
            .navigationTitle("Menu")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .navigationDestination(for: Destination.self) { destination in
                switch destination {
                case .myreports: MyReportsView()
                case .plan: PlanView()
                case .about: AboutView()
                case .responder:
                    // Replaces the menu with the prefilled report sheet.
                    ResponderView(onReport: actions.openReport)
                }
            }
        }
    }
}

#Preview {
    AppMenu()
        .environment(LiveStore())
        .environment(LocationProvider())
        .environment(MeetingPlanStore())
}
