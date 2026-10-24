import SwiftUI

/// Debug builds accept `-screen <name>` to open a screen directly for screenshots: `menu`,
/// `report`, `myreports`, `responder`, `plan` or `about`. Anything else opens the incident screen.
/// See also `joinCode`.
enum DebugLaunch {
    static var screen: String? {
        #if DEBUG
        return UserDefaults.standard.string(forKey: "screen")
        #else
        return nil
        #endif
    }

    /// `-join <code>` joins as a responder on launch, so the task card can be captured.
    static var joinCode: String? {
        #if DEBUG
        return UserDefaults.standard.string(forKey: "join")
        #else
        return nil
        #endif
    }
}

/// Destinations the resident-app views (Family, the web simulation feed) ask to open.
enum AppTab: Hashable {
    case family, plan
}

/// The phone is one screen about the live incident; everything else sits behind its menu.
struct RootView: View {
    /// The household meeting plan, opened from the menu.
    @State private var planStore = MeetingPlanStore()
    /// Live situation, guidance, reports and check-ins (ADR 0011, 0012).
    @State private var liveStore = LiveStore()
    @State private var location = LocationProvider()
    /// The web pages' simulation broadcast (ADR 0016); polled only while its screen is open.
    @State private var broadcastStore = BroadcastStore()
    @State private var familyStore = FamilyStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        IncidentView()
            .environment(planStore)
            .environment(liveStore)
            .environment(location)
            .environment(broadcastStore)
            .environment(familyStore)
            .tint(Color.ctBrand)
            .task(id: scenePhase) {
                guard scenePhase == .active else { return }
                while !Task.isCancelled {
                    if familyStore.isJoined { await familyStore.refresh() }
                    try? await Task.sleep(for: FamilyStore.pollInterval)
                }
            }
            // A family member changed the shared meeting points: use them on this phone too.
            // A new family whose points nobody has set yet leaves this phone's points alone.
            .onChange(of: familyStore.family?.meetingPointsUpdatedAt) {
                guard let family = familyStore.family, family.meetingPointsUpdatedBy != nil else { return }
                planStore.update { plan in
                    plan.primary = family.primary
                    plan.backup = family.backup
                }
            }
    }
}
