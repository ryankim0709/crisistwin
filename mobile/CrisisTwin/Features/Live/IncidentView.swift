import SwiftUI

/// The Map tab (ADR 0012): the full-bleed `IncidentMap`, the guidance drawer above the accessory,
/// and the floating controls. Each has one reserved place, so nothing collides at any drawer
/// height: the legend top-leading (the system compass takes top-trailing), follow and Report
/// stacked on the right edge riding just above the drawer, and the drawer at the bottom. The
/// controls step aside when the drawer leaves them no room. No navigation bar; the Exercise tag
/// lives in the drawer's header. Reads `LiveStore`, `LocationProvider` and `AppRouter`.
struct IncidentView: View {
    @Environment(LiveStore.self) private var store
    @Environment(LocationProvider.self) private var location
    @Environment(AppRouter.self) private var router
    @Environment(\.reportZoom) private var reportZoom
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The drawer's current height (follows the drag); 0 without a drawer.
    @State private var drawerHeight: CGFloat = 0
    /// The drawer's collapsed height, which the map camera keeps clear.
    @State private var collapsedHeight: CGFloat = 0
    @State private var legendHeight: CGFloat = 0

    init() {}

    private static let inset: CGFloat = 8
    private static let gap: CGFloat = 12
    private static let controlSize: CGFloat = 56
    /// Follow and Report, stacked.
    private static let controlsHeight: CGFloat = controlSize * 2 + gap

    private var myLocation: LonLat? {
        location.lastLocation.map { LonLat(lon: $0.coordinate.longitude, lat: $0.coordinate.latitude) }
    }

    /// The drawer shows with guidance, or with a one-line header when the person is in a zone.
    private var showsDrawer: Bool { store.activeGuidance != nil || store.myZone != nil }

    var body: some View {
        ZStack {
            IncidentMap(
                situation: store.situation, myLocation: myLocation, guidance: store.activeGuidance,
                zone: store.myZone, task: store.currentTask, taskTarget: store.currentTask.flatMap(store.taskTarget))
                .safeAreaPadding(.bottom, showsDrawer ? collapsedHeight + Self.inset : 0)
                .safeAreaPadding(.top, legendHeight > 0 ? legendHeight + Self.inset : 0)
            GeometryReader { geo in
                overlays(in: geo.size)
            }
        }
    }

    private func overlays(in size: CGSize) -> some View {
        let drawerTop = showsDrawer ? drawerHeight + Self.inset : 0
        let topReserved = legendHeight > 0 ? legendHeight + Self.inset * 2 : Self.inset
        let roomForControls = size.height - drawerTop - Self.gap - topReserved >= Self.controlsHeight
        return ZStack(alignment: .bottom) {
            Color.clear
            if showsDrawer {
                // 62% of the tab; more at large text sizes, when the collapsed drawer alone is that tall.
                let below = size.height - (legendHeight > 0 ? legendHeight + Self.inset * 2 : Self.inset)
                let open = min(below, max(size.height * 0.62, collapsedHeight + 280))
                GuidanceSheet(guidance: store.activeGuidance, maxHeight: open.rounded()) {
                    collapsedHeight = $0
                }
                .frame(width: max(0, size.width - Self.inset * 2))
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { drawerHeight = $0 }
                .padding(.horizontal, Self.inset)
                .padding(.bottom, Self.inset)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .onDisappear { drawerHeight = 0 }
            }
        }
        .overlay(alignment: .topLeading) {
            MapLegend(situation: store.situation)
                .frame(maxWidth: max(0, size.width - 32), alignment: .leading)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { legendHeight = $0 }
                .padding(.leading, 16)
                .padding(.top, Self.inset)
        }
        .overlay(alignment: .bottomTrailing) {
            controls
                .padding(.trailing, 16)
                .padding(.bottom, drawerTop + Self.gap)
                .opacity(roomForControls ? 1 : 0)
                .allowsHitTesting(roomForControls)
                .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: roomForControls)
        }
    }

    private var controls: some View {
        GlassEffectContainer(spacing: Self.gap) {
            VStack(alignment: .trailing, spacing: Self.gap) {
                followButton
                reportButton
            }
        }
    }

    private var followButton: some View {
        Button {
            router.following.toggle()
        } label: {
            Image(systemName: router.following ? "location.fill" : "location")
                .font(.title3.weight(.semibold))
                .contentTransition(.symbolEffect(.replace))
                .frame(width: Self.controlSize, height: Self.controlSize)
                .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .circle)
        .disabled(!location.isAuthorized)
        .accessibilityLabel(router.following ? "Stop following" : "Follow my location")
        .sensoryFeedback(.selection, trigger: router.following)
    }

    private var reportButton: some View {
        Button {
            router.openReport(from: "map-report")
        } label: {
            Label("Report", systemImage: "exclamationmark.bubble")
                .font(.headline)
                .padding(.horizontal, 20)
                .frame(height: Self.controlSize)
                .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .capsule)
        .reportZoomSource("map-report", in: reportZoom)
        .accessibilityLabel("Report what you see")
    }
}

/// The map's key, in words: the zone levels being shown and confirmed blocks, only those present.
/// Swatches repeat the map's own fill and edge, so color is never the only signal.
private struct MapLegend: View {
    let situation: Situation?

    private enum Entry: Hashable {
        case level(GuidanceLevel)
        case blocked
    }

    private var entries: [Entry] {
        let levels = Set((situation?.guidance ?? []).map(\.level))
        var entries: [Entry] = [GuidanceLevel.evacuateNow, .beReady].filter(levels.contains).map(Entry.level)
        if situation?.hazards.contains(where: { $0.kind == .roadBlocked }) == true { entries.append(.blocked) }
        return entries
    }

    var body: some View {
        let entries = self.entries
        if !entries.isEmpty {
            // One row; a column at large text sizes, so the key never runs off the screen.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { items(entries) }
                    .padding(.horizontal, 12)
                    .frame(minHeight: 32)
                    .glassEffect(.regular, in: .capsule)
                VStack(alignment: .leading, spacing: 4) { items(entries) }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .glassEffect(.regular, in: .rect(cornerRadius: 16))
            }
            .font(.ctMapLabel)
            .foregroundStyle(Color.ctInk)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Map key: " + entries.map(title).joined(separator: ", "))
        }
    }

    private func items(_ entries: [Entry]) -> some View {
        ForEach(entries, id: \.self) { entry in
            HStack(spacing: 6) {
                swatch(entry)
                Text(title(entry)).fixedSize()
            }
        }
    }

    private func title(_ entry: Entry) -> String {
        switch entry {
        case .level(.evacuateNow): return "Leave now"
        case .level(.beReady): return "Be ready"
        case .level(.none): return "No order"
        case .blocked: return "Blocked"
        }
    }

    @ViewBuilder private func swatch(_ entry: Entry) -> some View {
        switch entry {
        case .level(let level):
            let style = ZoneStyle(level: level)
            RoundedRectangle(cornerRadius: 3, style: .continuous)
                .fill(style.fill)
                .overlay(RoundedRectangle(cornerRadius: 3, style: .continuous).strokeBorder(style.edge, lineWidth: style.width))
                .frame(width: 14, height: 14)
        case .blocked:
            Image(systemName: "xmark.octagon.fill")
                .foregroundStyle(Color.ctHazard)
        }
    }
}
