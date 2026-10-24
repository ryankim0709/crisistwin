import SwiftUI

/// Former tab names. The phone has no tab bar any more (ADR 0012); kept because the unused
/// `HomeView` still takes an `openTab` callback.
enum AppTab: String, Hashable {
    case home, live, plan, practice
}

/// Debug builds accept `-screen <name>` to open a screen directly for screenshots: `menu`,
/// `report`, `myreports`, `responder`, `plan` or `about`. Anything else opens the incident screen.
enum DebugLaunch {
    static var screen: String? {
        #if DEBUG
        return UserDefaults.standard.string(forKey: "screen")
        #else
        return nil
        #endif
    }
}

/// The phone is one screen about the live incident; everything else sits behind its menu.
struct RootView: View {
    /// The household meeting plan, opened from the menu.
    @State private var planStore = MeetingPlanStore()
    /// Live situation, guidance, reports and check-ins (ADR 0011, 0012).
    @State private var liveStore = LiveStore()
    @State private var location = LocationProvider()

    var body: some View {
        IncidentView()
            .environment(planStore)
            .environment(liveStore)
            .environment(location)
            .tint(Color.ctBrand)
    }
}
