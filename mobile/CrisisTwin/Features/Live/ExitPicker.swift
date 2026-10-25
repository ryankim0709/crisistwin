import SwiftUI

extension RouteSafety {
    /// "Clear", "Passes near fire", "Passes fire".
    var word: String {
        switch self {
        case .clear: return "Clear"
        case .passesNearFire: return "Passes near fire"
        case .passesFire: return "Passes fire"
        }
    }

    var symbol: String {
        switch self {
        case .clear: return "checkmark.shield"
        case .passesNearFire: return "flame"
        case .passesFire: return "flame.fill"
        }
    }

    /// Quiet when clear; fire orange when the route meets the fire.
    var tint: Color {
        self == .clear ? .ctInkMuted : .ctFire
    }
}

extension GuidanceAlternative {
    /// "Busy" when most of the destination's capacity is already heading there; nil when not
    /// known or not busy.
    var loadWord: String? {
        guard let load, load >= 0.75 else { return nil }
        return "Busy"
    }
}

/// D1: where the person may go. The controller's pick is marked Recommended; each option shows
/// its ETA, its safety in words and, when busy, its load. Picking one switches this phone's route
/// and "Via ..." line and tells the server (`LiveStore.chooseDestination`). Renders nothing when
/// the server offers no choice. Used in the Map drawer and Home's guidance detail.
struct ExitPicker: View {
    /// The guidance as the phone follows it (`LiveStore.activeGuidance`).
    let guidance: ZoneGuidance

    @Environment(LiveStore.self) private var store
    @State private var sendFailed = false
    @State private var tick = 0

    private var options: [GuidanceAlternative] {
        store.publishedGuidance(for: guidance.zoneId)?.exitOptions ?? guidance.exitOptions
    }

    private var selectedId: String? { guidance.destination?.id }

    var body: some View {
        let options = self.options
        if !options.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(options) { option in
                    row(option)
                    if option.id != options.last?.id {
                        Divider().padding(.leading, 40)
                    }
                }
                if sendFailed {
                    Label("Couldn't send your pick. It stays on this phone.", systemImage: "wifi.slash")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(.top, 8)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .sensoryFeedback(.selection, trigger: tick)
        }
    }

    private func row(_ option: GuidanceAlternative) -> some View {
        let selected = option.id == selectedId
        return Button {
            pick(option)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(selected ? Color.ctRoute : Color.ctInkSubtle)
                    .frame(width: 28)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    // Tags beside the name when they fit; on their own line at large text sizes.
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            name(option, selected: selected).fixedSize()
                            tags(option)
                            Spacer(minLength: 8)
                            eta(option)
                        }
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                name(option, selected: selected)
                                Spacer(minLength: 8)
                                eta(option)
                            }
                            tags(option)
                        }
                    }
                    // The roads and distance tell apart two options to the same exit.
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        via(option)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 8)
                        Text(GuidanceSheet.distance(option.route.distanceM))
                            .monospacedDigit()
                            .foregroundStyle(Color.ctInkMuted)
                            .fixedSize()
                    }
                    .font(.footnote)
                    safety(option)
                        .font(.footnote.weight(.medium))
                }
            }
            .padding(.vertical, 12)
            .frame(minHeight: 52)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Self.spoken(option))
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("exit-\(option.id)")
    }

    private func name(_ option: GuidanceAlternative, selected: Bool) -> some View {
        Text(title(option))
            .font(.body.weight(selected ? .semibold : .regular))
            .foregroundStyle(Color.ctInk)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder private func tags(_ option: GuidanceAlternative) -> some View {
        if option.recommended || option.loadWord != nil {
            HStack(spacing: 6) {
                if option.recommended { tag("Recommended", fill: .ctBrandSoft, ink: .ctBrand) }
                if let load = option.loadWord { tag(load, fill: .ctWarningSoft, ink: .ctWarning) }
            }
        }
    }

    private func eta(_ option: GuidanceAlternative) -> some View {
        Text(Self.eta(option.route.etaMin))
            .font(.body.weight(.semibold))
            .monospacedDigit()
            .foregroundStyle(Color.ctInk)
            .fixedSize()
    }

    @ViewBuilder private func via(_ option: GuidanceAlternative) -> some View {
        if !option.route.via.isEmpty {
            Text("Via " + option.route.via.joined(separator: ", ")).foregroundStyle(Color.ctInkMuted)
        }
    }

    private func safety(_ option: GuidanceAlternative) -> some View {
        Label(option.safety.word, systemImage: option.safety.symbol)
            .foregroundStyle(option.safety.tint)
            .fixedSize()
    }

    /// The short name ("Exit east"), or the full one when another option shares the short name
    /// and the full name tells them apart ("Exit east via Camp Creek Road").
    private func title(_ option: GuidanceAlternative) -> String {
        let short = option.destination.shortName
        let shared = options.contains { $0.id != option.id && $0.destination.shortName == short }
        return shared ? option.destination.name : short
    }

    private func tag(_ text: String, fill: Color, ink: Color) -> some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(ink)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(fill, in: .rect(cornerRadius: 4))
            .fixedSize()
    }

    private func pick(_ option: GuidanceAlternative) {
        guard option.id != selectedId else { return }
        tick += 1
        sendFailed = false
        let zoneId = guidance.zoneId
        Task {
            do {
                try await store.chooseDestination(zoneId: zoneId, destinationId: option.id)
            } catch LiveAPIError.rejected {
                // No longer offered: the store restored the previous pick; the next poll updates the list.
            } catch {
                sendFailed = true
            }
        }
    }

    static func eta(_ minutes: Int) -> String { minutes < 1 ? "<1 min" : "\(minutes) min" }

    private static func spoken(_ option: GuidanceAlternative) -> String {
        var parts = [option.destination.shortName]
        if let road = option.route.via.first { parts.append("via \(road)") }
        parts += ["\(option.route.etaMin) minutes", option.safety.word]
        if option.recommended { parts.append("Recommended") }
        if let load = option.loadWord { parts.append(load) }
        return parts.joined(separator: ", ")
    }
}
