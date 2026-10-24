import SwiftUI
import UIKit

/// Home's Evacuate button. Three quick taps (within `window`) arm it so a pocket tap can't, then a
/// confirmation asks before anything happens. VoiceOver gets one plain activation, still confirmed.
// ponytail: Start does nothing yet; it will post "On the way" to the family, open Messages to the
// emergency contacts and show the backend's checked destinations (see mobile/README.md).
struct EvacuateButton: View {
    /// How long three taps may take, in seconds.
    static let window: TimeInterval = 1.5
    private static let tapsNeeded = 3

    @State private var taps: [Date] = []
    @State private var confirming = false
    @State private var reset: Task<Void, Never>?

    var body: some View {
        Button(action: tap) {
            HStack(spacing: 14) {
                Image(systemName: "figure.run")
                    .font(.title2.weight(.semibold))
                    .frame(width: 32)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Evacuate")
                        .font(.title3.weight(.bold))
                    Text(taps.isEmpty ? "Tap 3 times quickly" : "Keep tapping")
                        .font(.subheadline)
                        .opacity(0.9)
                }
                Spacer(minLength: 8)
                dots
            }
            .foregroundStyle(Color.white)
            .padding(.horizontal, 18)
            .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
            .background(Color.ctDanger, in: RoundedRectangle(cornerRadius: 18))
            .contentShape(RoundedRectangle(cornerRadius: 18))
        }
        .buttonStyle(.plain)
        .sensoryFeedback(.impact(weight: .medium), trigger: taps.count) { _, new in new > 0 }
        .accessibilityLabel("Evacuate")
        .accessibilityHint("Asks you to confirm before starting")
        .accessibilityAction { confirming = true }
        .confirmationDialog("Start evacuating?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Start", role: .destructive) {}
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Your family will see you're on the way, and a message to your emergency contacts will open.")
        }
    }

    /// One dot per tap so far; all three fill as the button arms.
    private var dots: some View {
        HStack(spacing: 6) {
            ForEach(0..<Self.tapsNeeded, id: \.self) { index in
                Circle()
                    .fill(index < taps.count ? Color.white : Color.white.opacity(0.35))
                    .frame(width: 10, height: 10)
            }
        }
        .accessibilityHidden(true)
    }

    private func tap() {
        let now = Date()
        taps = taps.filter { now.timeIntervalSince($0) < Self.window } + [now]
        reset?.cancel()
        if taps.count >= Self.tapsNeeded {
            taps = []
            confirming = true
            return
        }
        // Too slow: the dots clear and the count starts over.
        reset = Task {
            try? await Task.sleep(for: .seconds(Self.window))
            guard !Task.isCancelled else { return }
            taps = []
        }
    }
}
