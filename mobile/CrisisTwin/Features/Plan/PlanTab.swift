import CoreLocation
import SwiftUI
import UIKit
import UserNotifications

/// The Plan tab: the household's preparedness page. The meeting points lead, then the family
/// and emergency contacts; permissions, responder join, the web simulation feed and About
/// share one compact panel at the end.
struct PlanTab: View {
    enum Destination: String, Hashable {
        case family, familyJoin, meeting, broadcast, responder, about
    }

    @Environment(LiveStore.self) private var live
    @Environment(LocationProvider.self) private var location
    @Environment(BroadcastStore.self) private var broadcast
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var path: [Destination] = DebugLaunch.screen.flatMap(Destination.init(rawValue:)).map { [$0] } ?? []
    @State private var notifications: UNAuthorizationStatus?

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(spacing: 16) {
                    MeetingPointCard()
                    FamilyCard { mode in path.append(mode == .join ? .familyJoin : .family) }
                    TrustedContactsCard()
                    morePanel
                    roadObservations
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 24)
            }
            .ctScreenBackground()
            .navigationTitle("Plan")
            .navigationDestination(for: Destination.self) { destination in
                switch destination {
                case .family: FamilyView(openTab: open)
                case .familyJoin: FamilyView(openTab: open, initialMode: .join)
                case .meeting: PlanView()
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

    // MARK: The compact final panel

    private var morePanel: some View {
        VStack(spacing: 0) {
            settingsRow("Notifications", systemImage: "bell.fill", value: notificationText, isOn: notificationsOn)
            PlanRowDivider(leading: 48)
            settingsRow("Location", systemImage: "location.fill", value: locationText, isOn: locationOn)
            PlanRowDivider(leading: 48)
            linkRow(.responder, live.role == .civilian ? "Join as responder" : "Responder",
                    systemImage: "person.badge.shield.checkmark.fill")
            PlanRowDivider(leading: 48)
            linkRow(.broadcast, "Web simulation", systemImage: "dot.radiowaves.left.and.right")
            PlanRowDivider(leading: 48)
            linkRow(.about, "About", systemImage: "info.circle.fill")
        }
        .ctPanel(padding: 0)
        .padding(.horizontal, 0)
    }

    /// Per-device, off by default. One short line says what it sends.
    private var roadObservations: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle(isOn: Bindable(live).shareRoadObservations) {
                rowLabel("Share road observations", systemImage: "car.fill")
            }
            .accessibilityIdentifier("share-road-observations")
            .padding(.horizontal, 16)
            .frame(minHeight: 50)
            .ctPanel(padding: 0)
            Text("Sends only \u{201C}road passable\u{201D} or \u{201C}slow\u{201D} for board roads you drive through. No track.")
                .font(.footnote)
                .foregroundStyle(Color.ctInkMuted)
                .padding(.horizontal, 16)
        }
    }

    private func rowLabel(_ title: String, systemImage: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.body)
                .foregroundStyle(Color.ctInkMuted)
                .frame(width: 20)
                .accessibilityHidden(true)
            Text(title)
                .foregroundStyle(Color.ctInk)
            Spacer(minLength: 8)
        }
    }

    private func linkRow(_ destination: Destination, _ title: String, systemImage: String) -> some View {
        NavigationLink(value: destination) {
            HStack(spacing: 8) {
                rowLabel(title, systemImage: systemImage)
                chevron
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 50)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }

    /// A permission and its status; opens this app's page in Settings.
    private func settingsRow(_ title: String, systemImage: String, value: String, isOn: Bool) -> some View {
        Button {
            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
        } label: {
            HStack(spacing: 8) {
                rowLabel(title, systemImage: systemImage)
                Label(value, systemImage: isOn ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(isOn ? Color.ctSuccess : Color.ctWarning)
                    .labelStyle(PlanStatusLabelStyle())
                chevron
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 50)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens Settings")
    }

    private var chevron: some View {
        Image(systemName: "chevron.right")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(Color.ctInkSubtle)
            .accessibilityHidden(true)
    }

    private var notificationsOn: Bool {
        switch notifications {
        case .authorized, .provisional, .ephemeral: return true
        default: return false
        }
    }

    private var notificationText: String { notificationsOn ? "On" : "Off" }

    private var locationOn: Bool {
        location.authorization == .authorizedWhenInUse || location.authorization == .authorizedAlways
    }

    private var locationText: String {
        switch location.authorization {
        case .authorizedWhenInUse: return "While using"
        case .authorizedAlways: return "Always"
        default: return "Off"
        }
    }
}

/// Status words with a small trailing-aligned symbol.
private struct PlanStatusLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.icon.font(.caption)
            configuration.title
        }
    }
}
