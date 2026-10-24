import SwiftUI

/// A compact card asking about one nearby item; hidden when there is nothing to ask. Never asks
/// for location permission; it only uses it when already granted.
struct StillTherePrompt: View {
    @Environment(LiveStore.self) private var store
    @Environment(LocationProvider.self) private var location
    @State private var item: PublicMapItem?
    /// Dismissed for this session only.
    @State private var dismissed: Set<String> = []

    var body: some View {
        Group {
            if let item, !dismissed.contains(item.id) { card(item) }
        }
        .task(id: location.isAuthorized) {
            guard location.isAuthorized else { item = nil; return }
            while !Task.isCancelled {
                await check()
                try? await Task.sleep(for: .seconds(60))
            }
        }
    }

    private func check() async {
        guard let fix = try? await location.currentLocation(),
              let nearby = try? await store.prompts(
                near: LonLat(lon: fix.coordinate.longitude, lat: fix.coordinate.latitude)) else { return }
        item = nearby.first { !dismissed.contains($0.id) }
    }

    private func question(_ item: PublicMapItem) -> String {
        let road = item.roadRef?.name
        switch item.kind {
        case .roadBlocked: return "Is \(road ?? "this road") still blocked?"
        case .roadPassable: return "Is \(road ?? "this road") still passable?"
        case .heavyTraffic: return "Is traffic still heavy\(road.map { " on \($0)" } ?? "")?"
        default: return "Is this still there: \(item.kind.title.lowercased())\(road.map { " near \($0)" } ?? "")?"
        }
    }

    private func card(_ item: PublicMapItem) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: item.kind.systemImage)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(item.kind.tone.color)
                    .frame(width: 32, height: 32)
                    .background(item.kind.tone.color.opacity(0.12), in: Circle())
                    .accessibilityHidden(true)
                Text(question(item))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.ctInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(minHeight: 32)
                Spacer(minLength: 0)
                Button {
                    dismiss(item)
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(Color.ctMuted)
                        .frame(minWidth: 44, minHeight: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss")
            }
            HStack(spacing: 10) {
                Button("Yes") { answer(item, kind: item.kind.stillThereKind) }
                    .buttonStyle(LiveCompactButtonStyle(filled: true))
                // Only road items have an opposite report; for others "No" just closes the card.
                Button("No") {
                    if let gone = item.kind.goneKind { answer(item, kind: gone) } else { dismiss(item) }
                }
                .buttonStyle(LiveCompactButtonStyle(filled: false))
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.ctSurface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Color.ctBorder.opacity(0.7), lineWidth: 1))
        .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
    }

    private func dismiss(_ item: PublicMapItem) {
        dismissed.insert(item.id)
        self.item = nil
    }

    private func answer(_ item: PublicMapItem, kind: ReportKind) {
        store.submit(ReportDraft(
            incidentId: store.incidentId,
            kind: kind,
            severity: kind.hasSeverity ? item.severity : nil,
            location: ReportLocation(coord: item.coord, accuracyM: nil),
            observedAt: Date()))
        dismiss(item)
    }
}
