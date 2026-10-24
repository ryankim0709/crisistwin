import SwiftUI
import UIKit

/// Home is "My area": the zone's level as the Slab, its source and age, the two check-ins,
/// pending "still there?" questions, confirmed facts near the person and recent changes.
/// With no active fire nearby, a calm empty state and the household plan.
struct HomeView: View {
    @Environment(LiveStore.self) private var store
    @Environment(LocationProvider.self) private var location
    @Environment(AppRouter.self) private var router
    @Environment(\.openURL) private var openURL
    /// Family's "Choose meeting points" from the empty state's plan summary.
    @State private var showMeetingPoint = false

    var body: some View {
        NavigationStack {
            List {
                content
            }
            .listStyle(.insetGrouped)
            .navigationTitle(store.incidentTitle ?? "Home")
            .navigationSubtitle(store.myZone?.name ?? "")
            .toolbar {
                if store.isExercise {
                    ToolbarItem(placement: .topBarTrailing) { ExerciseTag() }
                }
            }
            .refreshable { await store.refresh() }
            .animation(.snappy, value: store.stillThereItems.map(\.id))
            .navigationDestination(isPresented: $showMeetingPoint) { PlanView() }
        }
    }

    @ViewBuilder private var content: some View {
        if !location.isAuthorized {
            locationOff
        } else if store.situation == nil {
            Section {
                if case .unavailable = store.connection {
                    Label("Can't reach the service", systemImage: "wifi.slash")
                    Button("Try again") { Task { await store.refresh() } }
                } else {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text("Connecting")
                    }
                }
            }
        } else if location.lastLocation == nil {
            Section {
                HStack(spacing: 12) {
                    ProgressView()
                    Text("Finding your location")
                }
            }
        } else if let zone = store.myZone {
            if let guidance = store.activeGuidance {
                Section {
                    Slab(
                        guidance: guidance,
                        passesFire: store.passesFire(guidance),
                        offlineSince: store.offlineSince,
                        incidentNow: { store.situation?.incidentNow(at: $0) ?? $0 },
                        openDestination: { router.showOnMap(nil) },
                        start: router.start)
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            } else {
                Section {
                    Label(GuidanceLevel.none.verdict(zone: zone.name), systemImage: GuidanceLevel.none.symbol)
                        .font(.headline)
                }
            }
            Section {
                CheckInButtons()
            }
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
            stillThere
            NearYouSection()
            changes
        } else {
            Section {
                ContentUnavailableView("No active fire near you", systemImage: "checkmark.shield")
            }
            .listRowBackground(Color.clear)
            PlanSummarySection { showMeetingPoint = true }
        }
    }

    private var locationOff: some View {
        let denied = location.authorization == .denied || location.authorization == .restricted
        return Section {
            Label("Turn on location to see guidance for where you are", systemImage: "location.slash")
                .fixedSize(horizontal: false, vertical: true)
            Button(denied ? "Open Settings" : "Turn on location") {
                if denied, let url = URL(string: UIApplication.openSettingsURLString) {
                    openURL(url)
                } else {
                    location.requestPermission()
                    location.startUpdating()
                }
            }
        }
    }

    @ViewBuilder private var stillThere: some View {
        let items = Array(store.stillThereItems.prefix(3))
        if !items.isEmpty {
            Section("Still there?") {
                ForEach(items) { StillThereRow(item: $0) }
            }
        }
    }

    /// The current version and the earlier ones seen on this phone, when anything changed.
    @ViewBuilder private var changes: some View {
        if let current = store.myGuidance, current.version > 1 || !store.guidanceHistory.isEmpty {
            Section("Changes") {
                ForEach([GuidanceHistoryEntry(previous: current)] + store.guidanceHistory) { entry in
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text("v\(entry.version)")
                            .font(.subheadline.weight(.semibold))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                            .frame(minWidth: 28, alignment: .leading)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(entry.title)
                            if !entry.reason.isEmpty {
                                Text(entry.reason)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: 8)
                        Text(entry.asOf, format: .dateTime.hour().minute())
                            .font(.footnote)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }
}

/// The served incident is not real: one small tag, in the toolbar (spec, "Exercise tag").
struct ExerciseTag: View {
    var body: some View {
        Text("Exercise")
            .font(.subheadline.weight(.semibold))
            .padding(.horizontal, 6)
            .accessibilityLabel("Exercise, not a real incident")
    }
}

/// Confirmed facts near the person: the fire estimate's distance and age, and public blocks on
/// or near their route.
private struct NearYouSection: View {
    @Environment(LiveStore.self) private var store

    /// Blocks farther than this from the person, and not on their route, are left out.
    private static let nearM = 3_000.0
    /// A block within this of a route point counts as on the route.
    private static let onRouteM = 60.0

    private struct Block: Identifiable {
        let item: PublicMapItem
        let onRoute: Bool
        let meters: Double
        var id: String { item.id }
    }

    var body: some View {
        let fireRow = fire
        let blocks = self.blocks
        if fireRow != nil || !blocks.isEmpty {
            Section("Near you") {
                if let fireRow {
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        row(symbol: "flame.fill", color: .ctFire, title: fireRow.title,
                            trailing: fireRow.distance,
                            detail: fireRow.asOf.map {
                                RelativeAge.text(from: $0, to: store.situation?.incidentNow(at: context.date) ?? context.date)
                            })
                    }
                }
                ForEach(blocks) { block in
                    row(symbol: "xmark.octagon.fill", color: .ctHazard, title: StillThereRow.title(block.item),
                        trailing: block.onRoute ? "On your route" : Self.distance(block.meters),
                        detail: Self.confirmations(block.item))
                }
            }
        }
    }

    private func row(symbol: String, color: Color, title: String, trailing: String, detail: String?) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(color)
                .frame(width: 28)
                .accessibilityHidden(true)
            Text(title)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                Text(trailing)
                    .multilineTextAlignment(.trailing)
                if let detail {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var fire: (title: String, distance: String, asOf: Date?)? {
        guard let fire = store.situation?.fire, fire.method != .none, let geometry = fire.geometry,
              let here = store.lastCoord, let nearest = ZoneLocator.nearest(on: geometry, to: here) else { return nil }
        let title = fire.method == .satellitePerimeter ? "Satellite perimeter" : "Fire estimate"
        let distance = nearest.meters < 50
            ? "Where you are"
            : "\(Self.distance(nearest.meters)) \(ZoneLocator.compassWord(from: here, to: nearest.coord))"
        return (title, distance, fire.asOf)
    }

    private var blocks: [Block] {
        guard let here = store.lastCoord else { return [] }
        let route: [LonLat] = store.activeGuidance?.route?.line ?? []
        // Items still asked about ("Still there?") are listed there, not twice.
        let asked = Set(store.stillThereItems.map(\.id))
        let hazards: [PublicMapItem] = (store.situation?.hazards ?? [])
            .filter { $0.kind == .roadBlocked && $0.coord.isValid && !asked.contains($0.id) }
        var result: [Block] = []
        for item in hazards {
            let points: [LonLat] = (item.line ?? []) + [item.coord]
            let onRoute = points.contains { p in Self.isNear(p, route) }
            let meters = Self.meters(here, item.coord)
            if onRoute || meters <= Self.nearM { result.append(Block(item: item, onRoute: onRoute, meters: meters)) }
        }
        result.sort { a, b in a.onRoute != b.onRoute ? a.onRoute : a.meters < b.meters }
        return Array(result.prefix(5))
    }

    private static func isNear(_ point: LonLat, _ line: [LonLat]) -> Bool {
        line.contains { meters(point, $0) <= onRouteM }
    }

    private static func meters(_ a: LonLat, _ b: LonLat) -> Double {
        let dx = (b.lon - a.lon) * 111_320 * cos(a.lat * .pi / 180), dy = (b.lat - a.lat) * 111_320
        return (dx * dx + dy * dy).squareRoot()
    }

    static func distance(_ meters: Double) -> String {
        Measurement(value: meters, unit: UnitLength.meters)
            .formatted(.measurement(width: .abbreviated, usage: .road))
    }

    private static func confirmations(_ item: PublicMapItem) -> String {
        if item.controllerConfirmed { return "Confirmed by incident command" }
        let count = item.independentParties + item.responderReports
        return count == 1 ? "1 confirmation" : "\(count) confirmations"
    }
}

/// The household plan at a glance, for Home's empty state.
struct PlanSummarySection: View {
    @Environment(MeetingPlanStore.self) private var plan
    @Environment(FamilyStore.self) private var family
    @Environment(GoBagStore.self) private var goBag
    /// Opens the meeting point screen (Family asks for it).
    var openMeetingPoint: () -> Void

    var body: some View {
        Section("Plan") {
            NavigationLink {
                PlanView()
            } label: {
                LabeledContent {
                    Text(plan.plan.primary?.name ?? "Not set")
                } label: {
                    Label("Meeting point", systemImage: "mappin.and.ellipse")
                }
            }
            NavigationLink {
                FamilyView(openTab: { tab in if tab == .plan { openMeetingPoint() } })
            } label: {
                LabeledContent {
                    Text(family.family?.name ?? "Not set")
                } label: {
                    Label("Household", systemImage: "person.3")
                }
            }
            NavigationLink {
                GoBagView()
            } label: {
                LabeledContent {
                    Text(goBag.summary).monospacedDigit()
                } label: {
                    Label("Go-bag", systemImage: "bag")
                }
            }
        }
    }
}
