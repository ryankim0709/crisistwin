import SwiftUI

struct ContentView: View {
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "flame")
                .font(.system(size: 48))
                .foregroundStyle(.orange)
            Text("CrisisTwin")
                .font(.largeTitle.bold())
            Text("Evacuation planning simulator")
                .foregroundStyle(.secondary)
        }
        .padding()
    }
}

#Preview {
    ContentView()
}
