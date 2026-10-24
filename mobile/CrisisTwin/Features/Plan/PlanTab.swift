import CoreLocation
import SwiftUI
import UIKit
import UserNotifications

/// The Plan tab, secondary to Home: the household (Family, meeting point, go-bag), permission
/// status, the web simulation feed, responder join and About, as grouped native lists.
struct PlanTab: View {
    enum Destination: String, Hashable {
        case family, meeting, gobag, broadcast, responder, about
    }

    @Environment(LiveStore.self) private var live
    @Environment(LocationProvider.self) private var location
    @Environment(MeetingPlanStore.self) private var plan
    @Environment(FamilyStore.self) private var family
    @Environment(GoBagStore.self) private var goBag
    @Environment(BroadcastStore.self) private var broadcast
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var path: [Destination] = DebugLaunch.screen.flatMap(Destination.init(rawValue:)).map { [$0] } ?? []
    @State private var notifications: UNAuthorizationStatus?

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section("Household") {
                    link(.family, "Family", systemImage: "person.3", value: family.family?.name ?? "Not set")
                    link(.meeting, "Meeting point", systemImage: "mappin.and.ellipse", value: plan.plan.primary?.name ?? "Not set")
                    link(.gobag, "Go-bag", systemImage: "bag", value: goBag.summary)
                }
                Section("Permissions") {
                    settingsRow("Notifications", systemImage: "bell", value: notificationText)
                    settingsRow("Location", systemImage: "location", value: locationText)
                }
                Section {
                    NavigationLink(value: Destination.broadcast) {
                        Label("Web simulation", systemImage: "dot.radiowaves.left.and.right")
                    }
                }
                Section {
                    NavigationLink(value: Destination.responder) {
                        Label(live.role == .civilian ? "Join as responder" : "Responder",
                              systemImage: "person.badge.shield.checkmark")
                    }
                }
                Section {
                    NavigationLink(value: Destination.about) {
                        Label("About", systemImage: "info.circle")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Plan")
            .toolbar {
                if live.isExercise {
                    ToolbarItem(placement: .topBarTrailing) { ExerciseTag() }
                }
            }
            .navigationDestination(for: Destination.self) { destination in
                switch destination {
                case .family: FamilyView(openTab: open)
                case .meeting: PlanView()
                case .gobag: GoBagView()
                case .broadcast:
                    BroadcastView(openTab: open)
                        .task {
                            while !Task.isCancelled {
                                await broadcast.refresh()
                                try? await Task.sleep(for: BroadcastStore.pollInterval)
                            }
                        }
                case .responder: JoinResponderView()
                case .about: AboutView()
                }
            }
            .task(id: scenePhase) {
                guard scenePhase == .active else { return }
                notifications = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
            }
        }
    }

    /// Family and the web simulation feed ask to open each other's screens.
    private func open(_ tab: AppTab) {
        switch tab {
        case .family: path.append(.family)
        case .plan: path.append(.meeting)
        default: break
        }
    }

    private func link(_ destination: Destination, _ title: String, systemImage: String, value: String) -> some View {
        NavigationLink(value: destination) {
            LabeledContent {
                Text(value).monospacedDigit()
            } label: {
                Label(title, systemImage: systemImage)
            }
        }
    }

    /// A permission and its status; opens this app's page in Settings.
    private func settingsRow(_ title: String, systemImage: String, value: String) -> some View {
        Button {
            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
        } label: {
            LabeledContent {
                Text(value)
            } label: {
                Label(title, systemImage: systemImage)
            }
            .contentShape(.rect)
        }
        .foregroundStyle(.primary)
        .accessibilityHint("Opens Settings")
    }

    private var notificationText: String {
        switch notifications {
        case .authorized, .provisional, .ephemeral: return "On"
        default: return "Off"
        }
    }

    private var locationText: String {
        switch location.authorization {
        case .authorizedWhenInUse: return "While using"
        case .authorizedAlways: return "On"
        default: return "Off"
        }
    }
}
