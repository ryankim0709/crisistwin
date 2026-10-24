import SwiftUI

struct RootView: View {
    var body: some View {
        TabView {
            NavigationStack {
                HomeView()
            }
            .tabItem {
                Label("Workspace", systemImage: "square.grid.2x2")
            }

            NavigationStack {
                ScenariosView()
            }
            .tabItem {
                Label("Scenarios", systemImage: "map")
            }

            NavigationStack {
                PlanView()
            }
            .tabItem {
                Label("My Plan", systemImage: "figure.2")
            }
        }
    }
}
