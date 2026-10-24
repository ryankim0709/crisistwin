import SwiftUI

enum AppTab: Hashable {
    case home, live, family, plan, practice
}

struct RootView: View {
    @State private var selection: AppTab = .home
    /// One plan shared by Home, Live and My Plan, so all show the same saved plan.
    @State private var planStore = MeetingPlanStore()
    @State private var liveStore = LiveStore()
    @State private var familyStore = FamilyStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TabView(selection: $selection) {
            NavigationStack {
                HomeView { selection = $0 }
            }
            .tabItem {
                Label("Home", systemImage: "house")
            }
            .tag(AppTab.home)

            NavigationStack {
                LiveView { selection = $0 }
            }
            .tabItem {
                Label("Live drill", systemImage: "dot.radiowaves.left.and.right")
            }
            .tag(AppTab.live)

            NavigationStack {
                FamilyView { selection = $0 }
            }
            .tabItem {
                Label("Family", systemImage: "person.3")
            }
            .tag(AppTab.family)

            NavigationStack {
                PlanView()
            }
            .tabItem {
                Label("My Plan", systemImage: "figure.2")
            }
            .tag(AppTab.plan)

            NavigationStack {
                ScenariosView()
            }
            .tabItem {
                Label("Practice", systemImage: "flame")
            }
            .tag(AppTab.practice)
        }
        .environment(planStore)
        .environment(liveStore)
        .environment(familyStore)
        // Poll only while the app is in the foreground; .task(id:) cancels on phase change.
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                await liveStore.refresh()
                try? await Task.sleep(for: LiveStore.pollInterval)
            }
        }
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
