import SwiftUI

struct ScenariosView: View {
    var body: some View {
        ContentUnavailableView {
            Label("No scenarios connected", systemImage: "map")
        } description: {
            Text("Mobile scenario support is coming next. For now, explore the map simulation in the web app.")
        }
        .background(Color("WorkspaceBackground"))
        .navigationTitle("Scenarios")
    }
}
