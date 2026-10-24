import SwiftUI

/// The guidance in full, opened from the Slab and the bottom accessory (design-v2, item 6):
/// the level and what it means with the reason, its source and age; the way out (destination,
/// ETA, roads in order, safety) with Start on Map and Change exit; the check-ins; the fire's
/// distance; and the recent versions with why they changed.
struct GuidanceDetailView: View {
    @Environment(LiveStore.self) private var store
    @Environment(AppRouter.self) private var router
    @Environment(\.dismiss) private var dismiss
    @State private var choosingExit = DebugLaunch.screen == "detailexit"

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if let guidance = store.myGuidance {
                            levelPanel(guidance)
                            if guidance.level != .none {
                                wayOut(guidance)
                                CheckInButtons(inDrawer: true)
                            }
                            firePanel
                            HomePanel(title: "Changes") {
                                GuidanceChangesList(current: store.publishedGuidance ?? guidance, history: store.guidanceHistory)
                            }
                        } else {
                            Label("No guidance for your area", systemImage: GuidanceLevel.none.symbol)
                                .font(.ctTitle)
                                .foregroundStyle(Color.ctInk)
                                .ctPanel()
                        }
                        Color.clear.frame(height: 1).id("detail-bottom")
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 4)
                    .padding(.bottom, 24)
                }
                .task {
                    guard DebugLaunch.scrollToBottom else { return }
                    try? await Task.sleep(for: .seconds(1.5))
                    proxy.scrollTo("detail-bottom", anchor: .bottom)
                }
            }
            .scrollEdgeEffectStyle(.hard, for: .top)
            .ctScreenBackground()
            .navigationTitle(store.myZone?.name ?? "Guidance")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done", systemImage: "xmark") { dismiss() }
                        .accessibilityLabel("Close")
                }
            }
        }
    }

    // MARK: Level

    /// The level in its tone, what it asks, why, and who stands behind it.
    private func levelPanel(_ guidance: ZoneGuidance) -> some View {
        let level = guidance.level
        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: level.symbol)
                    .foregroundStyle(level.glyph)
                    .accessibilityHidden(true)
                if let fill = level.fill {
                    Text(level.verdict(zone: nil))
                        .foregroundStyle(level == .beReady ? Color.ctInk : fill)
                } else {
                    Text(level.verdict(zone: store.myZone?.name))
                        .foregroundStyle(Color.ctInk)
                }
            }
            .font(.ctVerdict)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)

            Text(level.meaning)
                .foregroundStyle(Color.ctInk)
                .fixedSize(horizontal: false, vertical: true)

            if let reason = guidance.reasonText {
                Label {
                    Text(reason)
                } icon: {
                    Image(systemName: "info.circle")
                        .foregroundStyle(level.glyph)
                }
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color.ctInk)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("Why: \(reason)")
            }

            Divider().overlay(Color.ctBorder)

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if store.offlineSince == nil {
                    Image(systemName: Self.sourceSymbol(guidance))
                        .foregroundStyle(Color.ctBrand)
                        .accessibilityHidden(true)
                }
                GuidanceProvenance(
                    guidance: guidance, offlineSince: store.offlineSince,
                    incidentNow: { store.situation?.incidentNow(at: $0) ?? $0 })
            }
            .font(.footnote)
            .foregroundStyle(Color.ctInkMuted)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(level.soft, in: .rect(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(level == .none ? Color.ctBorder : level.glyph.opacity(0.35), lineWidth: 1))
    }

    private static func sourceSymbol(_ guidance: ZoneGuidance) -> String {
        if guidance.reasonCode?.contains("official") == true { return "building.columns" }
        return guidance.approvedBy == .controller ? "checkmark.seal" : "cpu"
    }

    // MARK: Way out

    private func wayOut(_ guidance: ZoneGuidance) -> some View {
        let canChoose = store.publishedGuidance(for: guidance.zoneId)?.exitOptions.isEmpty == false
        return HomePanel(title: "Way out") {
            VStack(alignment: .leading, spacing: 16) {
                if store.choiceWithdrawn(for: guidance.zoneId) {
                    Label("Your pick is no longer offered. Showing the recommended route.", systemImage: "arrow.uturn.backward")
                        .font(.footnote)
                        .foregroundStyle(Color.ctInkMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if choosingExit, canChoose {
                    ExitPicker(guidance: guidance)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
                if guidance.hasRoute {
                    wayOutRoute(guidance)
                } else {
                    Text("No open route. Shelter in place and tap Need help.")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(Color.ctInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .animation(.snappy, value: choosingExit)
            .animation(.snappy, value: guidance.destination?.id)
        } accessory: {
            if canChoose {
                Button(choosingExit ? "Done" : "Change exit") { choosingExit.toggle() }
                    .buttonStyle(CTPillButtonStyle(prominent: false, height: 36))
                    .font(.subheadline.weight(.semibold))
                    .accessibilityHint(choosingExit ? "Hides the other exits" : "Shows other exits for your area")
            }
        }
    }

    private func wayOutRoute(_ guidance: ZoneGuidance) -> some View {
                VStack(alignment: .leading, spacing: 16) {
                    // While the exits are listed, the list already names the pick and its ETA.
                    if !choosingExit { destination(guidance) }
                    if let caveat = store.caveatText(for: guidance) {
                        Label(caveat, systemImage: caveat.localizedCaseInsensitiveContains("near") ? "flame" : "flame.fill")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Color.ctDanger)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let route = guidance.route {
                        RouteSteps(roads: route.via, destination: guidance.destination?.shortName)
                    }
                    Button {
                        dismiss()
                        router.start()
                    } label: {
                        Label("Start on Map", systemImage: "location.north.line.fill")
                    }
                    .buttonStyle(CTPillButtonStyle(prominent: true, fullWidth: true, height: 50))
                    .accessibilityHint("Opens the map and follows you along the route")
                }
    }

    private func destination(_ guidance: ZoneGuidance) -> some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: "signpost.right.fill")
                .foregroundStyle(.white)
                .frame(width: 40, height: 40)
                .background(Color.ctRoute, in: .circle)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(guidance.destination?.shortName ?? "Destination")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Color.ctInk)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 10) {
                    // The caveat below already says it when every way out meets the fire.
                    if store.caveatText(for: guidance) == nil, let safety = store.routeSafety(guidance) {
                        RouteSafetyLabel(safety: safety)
                    }
                    if let meters = guidance.route?.distanceM, meters > 0 {
                        Text(HomeFacts.distance(meters))
                            .foregroundStyle(Color.ctInkMuted)
                            .monospacedDigit()
                    }
                }
                .font(.footnote.weight(.medium))
            }
            Spacer(minLength: 8)
            if let eta = guidance.etaText {
                Text(eta)
                    .font(.ctMetric)
                    .foregroundStyle(Color.ctInk)
                    .fixedSize()
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(guidance.spokenSentence)
    }

    // MARK: Fire

    @ViewBuilder private var firePanel: some View {
        let facts = HomeFacts(store: store, route: [])
        if let fire = facts.fire {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                HomeFactRow(
                    symbol: "flame.fill", color: .ctFire, title: fire.title, trailing: fire.distance,
                    detail: fire.asOf.map {
                        RelativeAge.text(from: $0, to: store.situation?.incidentNow(at: context.date) ?? context.date)
                    })
            }
            .ctPanel()
        }
    }
}

/// The roads to take, in order, ending at the destination: a quiet line of stops in the route
/// color. Only the roads the guidance names; there is no turn-by-turn.
private struct RouteSteps: View {
    let roads: [String]
    let destination: String?

    var body: some View {
        let stops = roads.map { (name: $0, isEnd: false) } + (destination.map { [(name: $0, isEnd: true)] } ?? [])
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(stops.enumerated()), id: \.offset) { index, stop in
                HStack(alignment: .top, spacing: 14) {
                    VStack(spacing: 0) {
                        Circle()
                            .fill(stop.isEnd ? Color.ctRoute : Color.ctSurface)
                            .strokeBorder(Color.ctRoute, lineWidth: 3)
                            .frame(width: 14, height: 14)
                            .padding(.top, 3)
                        if index < stops.count - 1 {
                            Rectangle()
                                .fill(Color.ctRoute.opacity(0.45))
                                .frame(width: 3)
                                .frame(minHeight: 18, maxHeight: .infinity)
                        }
                    }
                    .frame(width: 14)
                    Text(stop.name)
                        .font(stop.isEnd ? .body.weight(.semibold) : .body)
                        .foregroundStyle(Color.ctInk)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.bottom, index < stops.count - 1 ? 14 : 0)
                    Spacer(minLength: 0)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Route: " + stops.map(\.name).joined(separator: ", then "))
    }
}
