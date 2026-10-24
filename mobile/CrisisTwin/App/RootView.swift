import SwiftUI

enum AppTab: Hashable {
    case home, plan, practice
}

struct RootView: View {
    @State private var selection: AppTab = .home
    /// One plan shared by Home and My Plan, so both always show the same saved plan.
    @State private var planStore = MeetingPlanStore()

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
    }
}
