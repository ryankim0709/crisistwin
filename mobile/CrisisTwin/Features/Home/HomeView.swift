import MapKit
import SwiftUI
import UIKit

/// Home is "My area", one place per thing: the incident and its Exercise tag, the Slab (opens the
/// guidance detail), the way out with a live minimap and Start, the two check-ins, pending
/// "still there?" questions, confirmed facts near the person, recent changes and the family.
/// With no active fire nearby, a calm empty state and the household plan.
struct HomeView: View {
    @Environment(LiveStore.self) private var store
    @Environment(LocationProvider.self) private var location
    @Environment(AppRouter.self) private var router
    @State private var explainExercise = false

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        header
                        HomeStatusHero()
                        HomeAddressPanel()
                        content
                        HomePlanTiles()
                        Color.clear.frame(height: 1).id("home-bottom")
                    }
                    .ctScreenPadding()
                }
                .task {
                    if DebugLaunch.screen == "exercise" {
                        try? await Task.sleep(for: .seconds(2))
                        explainExercise = true
                    }
                    guard DebugLaunch.scrollToBottom else { return }
                    try? await Task.sleep(for: .seconds(2.5))
                    proxy.scrollTo("home-bottom", anchor: .bottom)
                }
            }
            .ctScreenBackground()
            .ctOwnHeader()
            .refreshable { await store.refresh() }
            .animation(.snappy, value: store.stillThereItems.map(\.id) + store.boardQuestions.map(\.id))
        }
    }

    // MARK: Header

    /// The shared page header; during an exercise its tag sits beside the name and explains itself.
    private var header: some View {
        CTPageHeader(title: "Home") {
            if store.isExercise {
                Button { explainExercise = true } label: { ExerciseTag() }
                    .buttonStyle(.plain)
                    .accessibilityHint("Explains the exercise")
                    .popover(isPresented: $explainExercise, arrowEdge: .top) {
                        Text(exerciseExplanation)
                            .font(.subheadline)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(idealWidth: 280)
                            .padding(16)
                            .presentationCompactAdaptation(.popover)
                    }
            }
            Spacer(minLength: 8)
            Button { router.openVoice() } label: {
                Label("Talk to report", systemImage: "mic.fill")
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                    .padding(.horizontal, 16)
                    .frame(minHeight: 44)
                    .contentShape(.capsule)
            }
            .buttonStyle(.plain)
            .glassEffect(.regular.interactive(), in: .capsule)
            .accessibilityLabel("Talk to report")
            .accessibilityHint("Opens the voice assistant")
        }
    }

    private var exerciseExplanation: String {
        if store.incidentTitle?.localizedCaseInsensitiveContains("camp fire") == true {
            return "A replay of the 2018 Camp Fire for practice. Guidance here is not an official order."
        }
        return "A replay of a past fire for practice. Guidance here is not an official order."
    }

    // MARK: Content

    /// Under the hero, only while the phone knows its zone: the order and its way out, check-ins,
    /// pending questions, nearby facts, changes and the family. The hero covers every other state.
    @ViewBuilder private var content: some View {
        if store.home != nil || (location.isAuthorized && location.lastLocation != nil),
           store.situation != nil, store.myZone != nil {
            if let guidance = store.activeGuidance {
                Slab(
                    guidance: guidance,
                    offlineSince: store.offlineSince,
                    incidentNow: { store.situation?.incidentNow(at: $0) ?? $0 },
                    open: router.openDetail)
                WayOutCard(guidance: guidance)
            } else {
                // No order: the minimap keeps the fire in view; the hero carries the verdict.
                HomeMiniMap(guidance: nil)
                    .frame(height: 170)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            CheckInButtons(inDrawer: true)
            stillThere
            HomeNearbyPanel()
            changes
            HomeFamilyPanel()
        }
    }

    @ViewBuilder private var stillThere: some View {
        let items = Array(store.stillThereItems.prefix(3))
        let board = store.boardQuestions
        if !items.isEmpty || !board.isEmpty {
            HomePanel(title: "Still there?") {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(items) { StillThereRow(item: $0) }
                    ForEach(board) { BoardQuestionRow(question: $0) }
                }
            }
        }
    }

    /// Shown once anything changed: the current version and the earlier ones seen on this phone.
    @ViewBuilder private var changes: some View {
        if let current = store.publishedGuidance, current.version > 1 || !store.guidanceHistory.isEmpty {
            HomePanel(title: "Changes") {
                GuidanceChangesList(current: current, history: store.guidanceHistory)
            }
        }
    }
}

// MARK: - Shared pieces (Home and the guidance detail)

/// A titled web-kit panel.
struct HomePanel<Content: View, Accessory: View>: View {
    let title: String
    @ViewBuilder var content: Content
    @ViewBuilder var accessory: Accessory

    init(title: String, @ViewBuilder content: () -> Content, @ViewBuilder accessory: () -> Accessory) {
        self.title = title
        self.content = content()
        self.accessory = accessory()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(.ctTitle)
                    .foregroundStyle(Color.ctInk)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 8)
                accessory
            }
            content
        }
        .ctPanel()
    }
}

extension HomePanel where Accessory == EmptyView {
    init(title: String, @ViewBuilder content: () -> Content) {
        self.init(title: title, content: content, accessory: { EmptyView() })
    }
}

/// The web kit's pill buttons: brand-filled for the primary action, brand-soft for secondary.
struct CTPillButtonStyle: ButtonStyle {
    var prominent: Bool
    var fullWidth = false
    var height: CGFloat = 44

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(prominent ? Color.ctSurface : Color.ctBrand)
            .padding(.horizontal, 16)
            .frame(maxWidth: fullWidth ? .infinity : nil, minHeight: height)
            .background(prominent ? Color.ctBrand : Color.ctBrandSoft, in: .capsule)
            .opacity(configuration.isPressed ? 0.8 : 1)
            .contentShape(.capsule)
    }
}

/// The server-driven label for a replayed incident, in the web EvidenceTag style: a small
/// warning-tone tag with words, never a button by itself.
struct ExerciseTag: View {
    var body: some View {
        Text("Exercise")
            .font(.caption.weight(.semibold))
            .foregroundStyle(Color.ctWarning)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Color.ctWarningSoft, in: .capsule)
            .overlay(Capsule().strokeBorder(Color.ctWarning.opacity(0.35), lineWidth: 1))
            .fixedSize()
            .dynamicTypeSize(...DynamicTypeSize.accessibility1)
            .accessibilityLabel("Exercise, not a real incident")
    }
}

extension LiveStore {
    /// The route's exposure to the fire: the server's word, else the device's own check.
    func routeSafety(_ guidance: ZoneGuidance) -> RouteSafety? {
        if let safety = guidance.route?.safety { return safety }
        if let match = guidance.exitOptions.first(where: { $0.id == guidance.destination?.id }) {
            return match.safety
        }
        return passesFire(guidance) ? .passesFire : nil
    }
}

/// Route safety in words with a symbol, never color alone.
struct RouteSafetyLabel: View {
    let safety: RouteSafety

    var body: some View {
        Label(safety.word, systemImage: safety.symbol)
            .foregroundStyle(safety.tint)
    }
}

/// The way out on Home: the live minimap, the road to leave by, the destination and ETA, and
/// Start. The minimap opens the Map tab.
private struct WayOutCard: View {
    let guidance: ZoneGuidance

    @Environment(LiveStore.self) private var store
    @Environment(AppRouter.self) private var router

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { router.showOnMap(nil) } label: {
                HomeMiniMap(guidance: guidance)
                    .frame(height: 190)
                    .clipShape(UnevenRoundedRectangle(topLeadingRadius: 11, topTrailingRadius: 11))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Map of your area")
            .accessibilityHint("Opens the map")

            VStack(alignment: .leading, spacing: 12) {
                if guidance.hasRoute {
                    VStack(alignment: .leading, spacing: 6) {
                        if let via = guidance.viaText {
                            Text(via)
                                .font(.title3.weight(.semibold))
                                .foregroundStyle(Color.ctInk)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if let caveat = store.caveatText(for: guidance) {
                            Label(caveat, systemImage: caveat.localizedCaseInsensitiveContains("near") ? "flame" : "flame.fill")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Color.ctDanger)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    Button(action: router.openDetail) { destinationRow }
                        .buttonStyle(.plain)
                        .accessibilityLabel(guidance.spokenSentence)
                        .accessibilityHint("Shows the route and other exits")
                    Button("Start", action: router.start)
                        .buttonStyle(CTPillButtonStyle(prominent: true, fullWidth: true, height: 50))
                        .accessibilityHint("Opens the map and follows you along the route")
                } else {
                    Text("No open route. Shelter in place and tap Need help.")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(Color.ctInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(16)
        }
        .ctPanel(padding: 0)
    }

    private var destinationRow: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: "signpost.right.fill")
                .font(.body)
                .foregroundStyle(.white)
                .frame(width: 34, height: 34)
                .background(Color.ctRoute, in: .circle)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(guidance.destination?.shortName ?? "Destination")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Color.ctInk)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                // The headline caveat already says it when every way out meets the fire.
                if store.caveatText(for: guidance) == nil, let safety = store.routeSafety(guidance) {
                    RouteSafetyLabel(safety: safety)
                        .font(.footnote.weight(.medium))
                }
            }
            Spacer(minLength: 8)
            if let eta = guidance.etaText {
                Text(eta)
                    .font(.title2.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(Color.ctInk)
                    .contentTransition(.numericText())
                    .fixedSize()
            }
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.bold))
                .foregroundStyle(Color.ctInkSubtle)
                .accessibilityHidden(true)
        }
        .frame(minHeight: 44)
        .contentShape(.rect)
    }
}

/// A read-only live map of the person's area: the fire estimate, their zone in its level's
/// colors, the route and the destination. Framed on the zone, the route and the nearest fire edge.
struct HomeMiniMap: View {
    let guidance: ZoneGuidance?

    @Environment(LiveStore.self) private var store
    @Environment(\.colorScheme) private var colorScheme
    @State private var camera: MapCameraPosition = .region(LiveMap.campRegion)

    private var level: GuidanceLevel { guidance?.level ?? .none }

    private var routeLine: [LonLat] {
        guard let guidance, guidance.hasRoute else { return [] }
        return (guidance.route?.line ?? []).filter(\.isValid)
    }

    private var frameKey: String {
        [store.myZone?.id ?? "", guidance.map { "\($0.version)\($0.destination?.id ?? "")" } ?? "",
         store.situation?.fire.asOf?.description ?? ""].joined(separator: "|")
    }

    var body: some View {
        let fire = store.situation?.fire
        let firePolygons = fire?.geometry.map(Self.polygons) ?? []
        let zonePolygons = store.myZone.map { Self.polygons($0.geometry) } ?? []
        let route = routeLine.map(\.clCoordinate)
        let dark = colorScheme == .dark
        let zoneStroke = level == .none ? Color.ctInkMuted : level.glyph

        Map(position: $camera, interactionModes: []) {
            ForEach(Array(zonePolygons.enumerated()), id: \.offset) { _, polygon in
                MapPolygon(polygon)
                    .foregroundStyle(level == .none ? Color.clear : (level.fill ?? .clear).opacity(dark ? 0.22 : 0.18))
                    .stroke(zoneStroke, style: StrokeStyle(lineWidth: 2, lineJoin: .round, dash: level == .none ? [3, 4] : []))
            }
            ForEach(Array(firePolygons.enumerated()), id: \.offset) { _, polygon in
                MapPolygon(polygon)
                    .foregroundStyle(Color.ctFire.opacity(dark ? 0.30 : 0.24))
                    .stroke(Color.ctFire, style: StrokeStyle(
                        lineWidth: 2, lineJoin: .round, dash: fire?.method == .satellitePerimeter ? [] : [6, 4]))
            }
            if route.count > 1 {
                MapPolyline(coordinates: route)
                    .stroke(Color.ctCasing, style: StrokeStyle(lineWidth: 8, lineCap: .round, lineJoin: .round))
                MapPolyline(coordinates: route)
                    .stroke(Color.ctRoute, style: StrokeStyle(
                        lineWidth: 4.5, lineCap: .round, lineJoin: .round, dash: level == .beReady ? [7, 5] : []))
            }
            if let destination = guidance?.destination, destination.coord.isValid, guidance?.hasRoute == true {
                Annotation(destination.shortName, coordinate: destination.coord.clCoordinate, anchor: .center) {
                    Image(systemName: "signpost.right.fill")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.white)
                        .frame(width: 22, height: 22)
                        .background(Color.ctRoute, in: .circle)
                        .overlay(Circle().strokeBorder(.white, lineWidth: 1.5))
                }
                .annotationTitles(.hidden)
            }
            UserAnnotation()
        }
        .mapStyle(.standard(elevation: .flat, emphasis: .muted, pointsOfInterest: .excludingAll))
        .tint(Color.ctRoute)
        // Frame below the legend so it never covers the fire or the route.
        .safeAreaPadding(.top, 34)
        .allowsHitTesting(false)
        .overlay(alignment: .topLeading) { legend }
        .onChange(of: frameKey, initial: true) { _, _ in frame() }
        .accessibilityHidden(true)
    }

    /// Words, never color alone: what the shapes are.
    private var legend: some View {
        HStack(spacing: 12) {
            if store.situation?.fire.geometry != nil {
                key(color: .ctFire, text: "Fire")
            }
            if store.myZone != nil {
                key(color: level == .none ? .ctInkMuted : level.glyph, text: "Your zone")
            }
            if routeLine.count > 1 {
                key(color: .ctRoute, text: "Route")
            }
        }
        .font(.caption2.weight(.semibold))
        .foregroundStyle(Color.ctInk)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.ctSurface.opacity(0.92), in: .capsule)
        .dynamicTypeSize(...DynamicTypeSize.xLarge)
        .padding(8)
    }

    private func key(color: Color, text: String) -> some View {
        HStack(spacing: 4) {
            Capsule().fill(color).frame(width: 12, height: 4)
            Text(text)
        }
    }

    /// Frames the zone, the person, the first stretch of the route and the nearest fire edge, so
    /// the zone reads at a glance; the whole route is on the Map tab.
    private func frame() {
        var points: [LonLat] = []
        if let zone = store.myZone { points += zone.geometry.polygons.flatMap { $0.first ?? [] } }
        if let here = store.lastCoord {
            points.append(here)
            points += routeLine.filter { HomeFacts.meters(here, $0) <= Self.routeLeadM }
        } else {
            points += routeLine
        }
        // The nearest fire edge, when it is close enough to share the frame.
        if let here = store.lastCoord, let geometry = store.situation?.fire.geometry,
           let nearest = ZoneLocator.nearest(on: geometry, to: here), nearest.meters < 15_000 {
            points.append(nearest.coord)
        }
        if points.isEmpty, let rings = store.situation?.fire.geometry?.polygons {
            points = rings.flatMap { $0.first ?? [] }
        }
        guard let rect = Self.boundingRect(points) else { return }
        camera = .rect(rect)
    }

    /// How much of the route, from the person, the minimap keeps in frame.
    private static let routeLeadM = 3_000.0

    private static func boundingRect(_ points: [LonLat]) -> MKMapRect? {
        let valid = points.filter(\.isValid)
        guard let first = valid.first else { return nil }
        var rect = MKMapRect(origin: MKMapPoint(first.clCoordinate), size: MKMapSize(width: 0, height: 0))
        for point in valid.dropFirst() {
            rect = rect.union(MKMapRect(origin: MKMapPoint(point.clCoordinate), size: MKMapSize(width: 0, height: 0)))
        }
        let minSide = 1_500 * MKMapPointsPerMeterAtLatitude(first.lat)
        let width = max(rect.size.width, minSide), height = max(rect.size.height, minSide)
        let centered = MKMapRect(x: rect.midX - width / 2, y: rect.midY - height / 2, width: width, height: height)
        return centered.insetBy(dx: -width * 0.12, dy: -height * 0.18)
    }

    private static func polygons(_ geometry: LiveGeometry) -> [MKPolygon] {
        geometry.polygons.compactMap { rings in
            guard let exterior = rings.first?.filter(\.isValid), exterior.count > 2 else { return nil }
            let holes = rings.dropFirst().compactMap { ring -> MKPolygon? in
                let coords = ring.filter(\.isValid).map(\.clCoordinate)
                return coords.count > 2 ? MKPolygon(coordinates: coords, count: coords.count) : nil
            }
            let coords = exterior.map(\.clCoordinate)
            return MKPolygon(coordinates: coords, count: coords.count, interiorPolygons: holes)
        }
    }
}

/// Confirmed facts near the person: the fire estimate's distance and age, and public blocks on
/// or near their route.
struct HomeFacts {
    struct Fire {
        var title: String
        var distance: String
        var asOf: Date?
    }

    struct Block: Identifiable {
        let item: PublicMapItem
        let onRoute: Bool
        let meters: Double
        var id: String { item.id }
    }

    var fire: Fire?
    var blocks: [Block]

    /// Blocks farther than this from the person, and not on their route, are left out.
    private static let nearM = 3_000.0
    /// A block within this of a route point counts as on the route.
    private static let onRouteM = 60.0

    @MainActor init(store: LiveStore, route: [LonLat]) {
        let here = store.lastCoord
        if let fire = store.situation?.fire, fire.method != .none, let geometry = fire.geometry,
           let here, let nearest = ZoneLocator.nearest(on: geometry, to: here) {
            let title = fire.method == .satellitePerimeter ? "Satellite perimeter" : "Fire estimate"
            let distance = nearest.meters < 50
                ? "Where you are"
                : "\(Self.distance(nearest.meters)) \(ZoneLocator.compassWord(from: here, to: nearest.coord))"
            self.fire = Fire(title: title, distance: distance, asOf: fire.asOf)
        }
        guard let here else { blocks = []; return }
        // Items still asked about ("Still there?") are listed there, not twice.
        let asked = Set(store.stillThereItems.map(\.id))
        var result: [Block] = []
        for item in store.situation?.hazards ?? [] where item.kind == .roadBlocked && item.coord.isValid && !asked.contains(item.id) {
            let points = (item.line ?? []) + [item.coord]
            let onRoute = points.contains { p in route.contains { Self.meters(p, $0) <= Self.onRouteM } }
            let meters = Self.meters(here, item.coord)
            if onRoute || meters <= Self.nearM { result.append(Block(item: item, onRoute: onRoute, meters: meters)) }
        }
        result.sort { a, b in a.onRoute != b.onRoute ? a.onRoute : a.meters < b.meters }
        blocks = Array(result.prefix(5))
    }

    var isEmpty: Bool { fire == nil && blocks.isEmpty }

    static func meters(_ a: LonLat, _ b: LonLat) -> Double {
        let dx = (b.lon - a.lon) * 111_320 * cos(a.lat * .pi / 180), dy = (b.lat - a.lat) * 111_320
        return (dx * dx + dy * dy).squareRoot()
    }

    static func distance(_ meters: Double) -> String {
        Measurement(value: meters, unit: UnitLength.meters)
            .formatted(.measurement(width: .abbreviated, usage: .road))
    }

    static func confirmations(_ item: PublicMapItem) -> String {
        if item.controllerConfirmed { return "Confirmed by incident command" }
        let count = item.independentParties + item.responderReports
        return count == 1 ? "1 confirmation" : "\(count) confirmations"
    }
}

/// One fact row: a symbol, what it is and how old or how sure, and where it is trailing.
struct HomeFactRow: View {
    let symbol: String
    let color: Color
    let title: String
    let trailing: String
    let detail: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(color)
                .frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .foregroundStyle(Color.ctInk)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(Color.ctInkMuted)
                        .monospacedDigit()
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            Text(trailing)
                .font(.body.weight(.semibold))
                .foregroundStyle(Color.ctInk)
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Home's "Near you".
private struct HomeNearbyPanel: View {
    @Environment(LiveStore.self) private var store
    @State private var history: [FireTrend.Sample] = []

    var body: some View {
        let route = store.activeGuidance?.route?.line ?? []
        let facts = HomeFacts(store: store, route: route)
        if !facts.isEmpty {
            HomePanel(title: "Near you") {
                VStack(alignment: .leading, spacing: 12) {
                    if let fire = facts.fire {
                        TimelineView(.periodic(from: .now, by: 30)) { context in
                            HomeFactRow(
                                symbol: "flame.fill", color: .ctFire, title: fire.title, trailing: fire.distance,
                                detail: fire.asOf.map {
                                    let age = RelativeAge.text(from: $0, to: store.situation?.incidentNow(at: context.date) ?? context.date)
                                    guard let trend = FireTrend.text(history) else { return age }
                                    return "\(age) · \(trend)"
                                })
                        }
                    }
                    ForEach(facts.blocks) { block in
                        HomeFactRow(
                            symbol: "xmark.octagon.fill", color: .ctHazard, title: StillThereRow.title(block.item),
                            trailing: block.onRoute ? "On your route" : HomeFacts.distance(block.meters),
                            detail: HomeFacts.confirmations(block.item))
                    }
                }
            }
            .onChange(of: store.situation?.fire, initial: true) { _, _ in record() }
            .onChange(of: store.lastCoord) { _, _ in record() }
        }
    }

    /// Adds the current estimate's distance to the in-memory history, keyed by its drill time.
    private func record() {
        guard let fire = store.situation?.fire, fire.method != .none, let asOf = fire.asOf,
              let geometry = fire.geometry, let here = store.lastCoord,
              let nearest = ZoneLocator.nearest(on: geometry, to: here) else { return }
        FireTrend.add(&history, FireTrend.Sample(asOf: asOf, meters: nearest.meters))
    }
}

/// Whether the fire estimate has moved closer, from successive estimates on this device. A
/// derived observation of the model's estimates (in drill time), never a forecast.
enum FireTrend {
    struct Sample: Equatable {
        var asOf: Date
        var meters: Double
    }

    private static let window: TimeInterval = 20 * 60
    private static let minSpan: TimeInterval = 5 * 60
    private static let minChangeM = 80.0

    static func add(_ history: inout [Sample], _ sample: Sample) {
        if let i = history.firstIndex(where: { $0.asOf == sample.asOf }) {
            history[i] = sample
        } else {
            history.append(sample)
            history.sort { $0.asOf < $1.asOf }
        }
        if history.count > 40 { history.removeFirst(history.count - 40) }
    }

    static func text(_ history: [Sample]) -> String? {
        guard let latest = history.last,
              let base = history.first(where: { latest.asOf.timeIntervalSince($0.asOf) <= window }),
              latest.asOf.timeIntervalSince(base.asOf) >= minSpan else { return nil }
        let delta = base.meters - latest.meters
        guard abs(delta) >= minChangeM else { return nil }
        let minutes = Int((latest.asOf.timeIntervalSince(base.asOf) / 60).rounded())
        return "\(HomeFacts.distance(abs(delta))) \(delta > 0 ? "closer" : "farther") in the last \(minutes) min"
    }
}

/// The guidance versions, newest first: "v2 Leave now via Fairview Drive" and why.
struct GuidanceChangesList: View {
    let current: ZoneGuidance
    let history: [GuidanceHistoryEntry]

    var body: some View {
        let entries = [GuidanceHistoryEntry(previous: current)] + history
        VStack(alignment: .leading, spacing: 12) {
            ForEach(entries) { entry in
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text("v\(entry.version)")
                        .font(.subheadline.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(entry.version == current.version ? Color.ctBrand : Color.ctInkMuted)
                        .frame(minWidth: 28, alignment: .leading)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(entry.title)
                            .foregroundStyle(Color.ctInk)
                            .fixedSize(horizontal: false, vertical: true)
                        if !entry.reason.isEmpty {
                            Text(entry.reason)
                                .font(.footnote)
                                .foregroundStyle(Color.ctInkMuted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    Spacer(minLength: 8)
                    Text(entry.asOf, format: .dateTime.hour().minute())
                        .font(.footnote)
                        .monospacedDigit()
                        .foregroundStyle(Color.ctInkMuted)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}

extension MemberStatus {
    /// Status tone for a family member; always paired with the word and symbol.
    var tone: Color {
        switch self {
        case .safe, .atMeetingPoint: return .ctSuccess
        case .onTheWay: return .ctInfo
        case .needHelp: return .ctDanger
        case .unknown: return .ctInkMuted
        }
    }
}

/// The household's status at a glance; the full Family screen lives in Plan.
private struct HomeFamilyPanel: View {
    @Environment(FamilyStore.self) private var familyStore
    @Environment(AppRouter.self) private var router

    var body: some View {
        Button { router.tab = .plan } label: {
            if let family = familyStore.family {
                HomePanel(title: "Family") {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(family.members) { member in
                            HStack(spacing: 12) {
                                Text(member.isMe ? "You" : member.name)
                                    .foregroundStyle(Color.ctInk)
                                    .lineLimit(1)
                                Spacer(minLength: 8)
                                Label(member.memberStatus.label, systemImage: member.memberStatus.systemImage)
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(member.memberStatus.tone)
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                } accessory: {
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(Color.ctInkSubtle)
                }
            } else {
                HStack(spacing: 12) {
                    Image(systemName: "person.3")
                        .foregroundStyle(Color.ctBrand)
                        .frame(width: 28)
                    Text("Family")
                        .font(.ctTitle)
                        .foregroundStyle(Color.ctInk)
                    Spacer(minLength: 8)
                    Text("Not set up")
                        .foregroundStyle(Color.ctInkMuted)
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(Color.ctInkSubtle)
                }
                .ctPanel()
            }
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens your plan")
    }
}
