import CoreLocation
import SwiftUI

/// The Map tab's guidance drawer (D3), a real sheet with two detents.
///
/// Collapsed: the way out ("Via Fairview Drive") with the Exercise tag inline, the caveat, the
/// destination and its ETA, and the two check-ins. The verdict is not here: the accessory
/// directly below carries it. Expanded (dragged up, or the grabber or destination tapped): the
/// exit choice (D1), the route's steps, the confirmed facts near the person with their age and
/// confirmations, and the person's recent reports. Without anything to expand there is no grabber.
struct GuidanceSheet: View {
    /// The guidance the phone follows (`LiveStore.activeGuidance`); nil shows a one-line header.
    let guidance: ZoneGuidance?
    /// The tallest the drawer may grow (62% of the Map tab's safe area).
    let maxHeight: CGFloat
    /// Reports the collapsed height, for the map camera and the floating controls.
    var onCollapsedHeight: (CGFloat) -> Void = { _ in }

    @Environment(LiveStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expanded = false
    @State private var drag: CGFloat = 0
    @State private var collapsedHeight: CGFloat = 0
    @State private var contentHeight: CGFloat = 0

    private static let radius: CGFloat = 34
    private static let spring = Animation.spring(response: 0.35, dampingFraction: 0.85)

    /// Whether the expanded part has anything to show.
    private var hasDetails: Bool {
        guard let guidance else { return false }
        return guidance.hasRoute || !nearFacts.isEmpty || !store.myReports.isEmpty || !store.pending.isEmpty
    }

    private var openHeight: CGFloat {
        max(collapsedHeight, min(maxHeight, collapsedHeight + contentHeight))
    }

    private var height: CGFloat {
        let base = expanded ? openHeight : collapsedHeight
        return min(openHeight, max(collapsedHeight, base - drag))
    }

    /// 0 collapsed, 1 expanded.
    private var progress: CGFloat {
        let span = openHeight - collapsedHeight
        return span > 1 ? (height - collapsedHeight) / span : 0
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Self.radius, style: .continuous)
        VStack(spacing: 0) {
            header
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: {
                    collapsedHeight = $0
                    onCollapsedHeight($0)
                }
                .gesture(dragGesture, isEnabled: hasDetails)
            if hasDetails {
                ScrollView {
                    details
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
                }
                .scrollDisabled(progress < 0.99)
                .scrollEdgeEffectStyle(.soft, for: .top)
                .scrollBounceBehavior(.basedOnSize)
                .frame(height: collapsedHeight > 0 ? max(0, height - collapsedHeight) : 0)
                .opacity(Double(progress))
                .accessibilityHidden(!expanded)
            }
        }
        .frame(maxWidth: .infinity, alignment: .top)
        .clipShape(shape)
        // Glass while collapsed over the map; a solid surface as it opens, so lists stay legible.
        .background { shape.fill(Color.ctSurface).opacity(Double(progress)) }
        .glassEffect(.regular, in: shape)
        .sensoryFeedback(.selection, trigger: expanded)
        .onChange(of: hasDetails) { _, has in if !has { expanded = false } }
    }

    // MARK: Collapsed

    private var header: some View {
        VStack(spacing: 0) {
            if hasDetails { grabber }
            headerContent
                .padding(.horizontal, 20)
                .padding(.top, hasDetails ? 2 : 20)
                .padding(.bottom, 20)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
    }

    private var headerContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let guidance, store.choiceWithdrawn(for: guidance.zoneId) {
                Label("Your pick is no longer offered. Showing the recommended route.",
                      systemImage: "arrow.uturn.backward")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Color.ctInkMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let guidance {
                if guidance.hasRoute {
                    VStack(alignment: .leading, spacing: 6) {
                        titleRow(guidance.viaText ?? guidance.destination?.shortName ?? "Leave now")
                        if let caveat = caveat(guidance) {
                            Label(caveat, systemImage: "flame.fill")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Color.ctFire)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    destinationRow(guidance)
                } else {
                    titleRow("No open route. Shelter in place and tap Need help.")
                }
                CheckInButtons(inDrawer: true)
            } else {
                titleRow(GuidanceLevel.none.verdict(zone: store.myZone?.name))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The first line, with the Exercise tag inline when the incident is not real.
    private func titleRow(_ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(text)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Color.ctInk)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
            if store.isExercise { ExerciseTag().fixedSize() }
        }
    }

    /// D2: the server's caveat, else the device's own check that the route runs through the fire.
    private func caveat(_ guidance: ZoneGuidance) -> String? {
        if let text = guidance.caveat?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty { return text }
        return store.passesFire(guidance) ? "Every way out passes the fire" : nil
    }

    /// The destination and ETA. With a choice on offer it opens the exit list in the drawer.
    @ViewBuilder private func destinationRow(_ guidance: ZoneGuidance) -> some View {
        let canChoose = !(store.publishedGuidance(for: guidance.zoneId)?.exitOptions ?? []).isEmpty
        let row = HStack(spacing: 8) {
            Text(guidance.destination?.shortName ?? "Destination")
                .foregroundStyle(Color.ctInk)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            if let eta = guidance.etaText {
                Text(eta)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Color.ctInk)
                    .monospacedDigit()
                    .contentTransition(.numericText())
                    .fixedSize()
            }
            if canChoose {
                Image(systemName: "chevron.up.chevron.down")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(Color.ctInkMuted)
                    .accessibilityHidden(true)
            }
        }
        .frame(minHeight: 44)
        .contentShape(.rect)

        if canChoose {
            Button { setExpanded(true) } label: { row }
                .buttonStyle(.plain)
                .accessibilityLabel(guidance.spokenSentence)
                .accessibilityHint("Shows other places to go")
                .accessibilityIdentifier("destination-row")
        } else {
            row
                .accessibilityElement(children: .combine)
                .accessibilityLabel(guidance.spokenSentence)
        }
    }

    // MARK: Grabber and drag

    private var grabber: some View {
        Capsule()
            .fill(Color.ctInkSubtle.opacity(0.5))
            .frame(width: 36, height: 5)
            .padding(.top, 8)
            .frame(maxWidth: .infinity, minHeight: 30, alignment: .top)
            .contentShape(.rect)
            .onTapGesture { setExpanded(!expanded) }
            .accessibilityElement()
            .accessibilityLabel("Guidance details")
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { setExpanded(!expanded) }
            .accessibilityAdjustableAction { direction in
                switch direction {
                case .increment: setExpanded(true)
                case .decrement: setExpanded(false)
                @unknown default: break
                }
            }
            .accessibilityIdentifier("sheet-grabber")
    }

    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: 8, coordinateSpace: .global)
            .onChanged { value in drag = value.translation.height }
            .onEnded { value in
                let velocity = value.velocity.height
                let target: Bool
                if abs(velocity) > 300 {
                    target = velocity < 0
                } else {
                    target = progress > 0.5
                }
                setExpanded(target)
            }
    }

    private func setExpanded(_ open: Bool) {
        withAnimation(reduceMotion ? nil : Self.spring) {
            expanded = open
            drag = 0
        }
    }

    // MARK: Expanded

    @ViewBuilder private var details: some View {
        VStack(alignment: .leading, spacing: 24) {
            if let guidance {
                if !(store.publishedGuidance(for: guidance.zoneId)?.exitOptions ?? []).isEmpty {
                    section("Go to") { ExitPicker(guidance: guidance) }
                }
                if guidance.hasRoute, let route = guidance.route {
                    section("Route") { RouteSteps(route: route, destination: guidance.destination) }
                }
            }
            let facts = nearFacts
            if !facts.isEmpty {
                section("Near you") {
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        let now = store.situation?.incidentNow(at: context.date) ?? context.date
                        VStack(alignment: .leading, spacing: 12) {
                            ForEach(facts) { fact in factRow(fact, now: now) }
                        }
                    }
                }
            }
            if !store.pending.isEmpty || !store.myReports.isEmpty {
                section("Your reports") { reportRows }
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 4)
        .padding(.bottom, 24)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.ctTitle)
                .foregroundStyle(Color.ctInk)
                .accessibilityAddTraits(.isHeader)
            content()
        }
    }

    // MARK: Near you

    private struct Fact: Identifiable {
        var id: String
        var symbol: String
        var color: Color
        var title: String
        var place: String?
        var detail: String?
        var at: Date?
    }

    /// The fire estimate (distance, direction, age), then confirmed public items on the route or
    /// within 3 km, nearest first, with their confirmation count and age.
    private var nearFacts: [Fact] {
        var facts: [Fact] = []
        let me = store.lastCoord
        if let fire = store.situation?.fire, fire.method != .none, let geometry = fire.geometry {
            var place: String?
            if let me, let nearest = ZoneLocator.nearest(on: geometry, to: me) {
                place = nearest.meters == 0 ? "You are inside it"
                    : "\(Self.distance(nearest.meters)) \(ZoneLocator.compassWord(from: me, to: nearest.coord))"
            }
            facts.append(Fact(id: "fire", symbol: "flame.fill", color: .ctFire,
                              title: fire.method == .satellitePerimeter ? "Satellite perimeter" : "Fire estimate",
                              place: place, detail: nil, at: fire.asOf))
        }
        let route = guidance?.route?.line.filter(\.isValid) ?? []
        let items = (store.situation?.hazards ?? []).filter { $0.coord.isValid && $0.kind != .roadPassable }
        let ranked: [(PublicMapItem, Bool, Double)] = items.compactMap { item in
            let here = CLLocation(latitude: item.coord.lat, longitude: item.coord.lon)
            let onRoute = route.contains {
                here.distance(from: CLLocation(latitude: $0.lat, longitude: $0.lon)) < 60
            }
            let meters = me.map { here.distance(from: CLLocation(latitude: $0.lat, longitude: $0.lon)) } ?? .infinity
            guard onRoute || meters <= 3_000 else { return nil }
            return (item, onRoute, meters)
        }
        for (item, onRoute, meters) in ranked.sorted(by: { ($0.1 ? 0 : 1, $0.2) < ($1.1 ? 0 : 1, $1.2) }).prefix(5) {
            facts.append(Fact(
                id: item.id, symbol: item.kind.systemImage, color: item.kind.symbolColor,
                title: StillThereRow.title(item),
                place: onRoute ? "On your route" : (meters.isFinite ? Self.distance(meters) : nil),
                detail: Self.confirmations(item), at: item.lastObservedAt))
        }
        return facts
    }

    private func factRow(_ fact: Fact, now: Date) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: fact.symbol)
                .foregroundStyle(fact.color)
                .frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(fact.title)
                        .foregroundStyle(Color.ctInk)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    if let place = fact.place {
                        Text(place)
                            .font(.subheadline)
                            .foregroundStyle(Color.ctInkMuted)
                            .monospacedDigit()
                            .multilineTextAlignment(.trailing)
                    }
                }
                let meta = [fact.detail, fact.at.map { RelativeAge.text(from: $0, to: now) }].compactMap { $0 }
                if !meta.isEmpty {
                    HStack(spacing: 12) {
                        ForEach(meta, id: \.self) { Text($0) }
                    }
                    .font(.footnote)
                    .foregroundStyle(Color.ctInkMuted)
                    .monospacedDigit()
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    static func distance(_ meters: Double) -> String {
        Measurement(value: meters, unit: UnitLength.meters)
            .formatted(.measurement(width: .abbreviated, usage: .road))
    }

    /// "Confirmed by incident command", "3 confirmations", "1 confirmation".
    static func confirmations(_ item: PublicMapItem) -> String {
        if item.controllerConfirmed { return "Confirmed by incident command" }
        let n = item.independentParties + item.responderReports
        return n == 1 ? "1 confirmation" : "\(n) confirmations"
    }

    // MARK: Your reports

    @ViewBuilder private var reportRows: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(store.pending.prefix(3)) { draft in
                reportRow(kind: draft.kind, road: nil, time: draft.observedAt, word: "Waiting to send", symbol: "clock")
            }
            ForEach(store.myReports.prefix(max(0, 4 - min(3, store.pending.count)))) { report in
                let progress = store.progress(of: report)
                reportRow(kind: report.kind, road: report.roadRef?.name, time: report.observedAt,
                          word: progress.word, symbol: progress.symbol)
            }
        }
    }

    private func reportRow(kind: ReportKind, road: String?, time: Date, word: String, symbol: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: kind.systemImage)
                .foregroundStyle(kind.symbolColor)
                .frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text([kind.title, road].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", "))
                    .foregroundStyle(Color.ctInk)
                    .fixedSize(horizontal: false, vertical: true)
                Label(word, systemImage: symbol)
                    .font(.footnote)
                    .foregroundStyle(Color.ctInkMuted)
            }
            Spacer(minLength: 8)
            Text(time, format: .dateTime.hour().minute())
                .font(.footnote)
                .monospacedDigit()
                .foregroundStyle(Color.ctInkMuted)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The route in order: each road to take, then the destination with the total distance and ETA.
private struct RouteSteps: View {
    let route: GuidanceRoute
    let destination: GuidanceDestination?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(route.via.enumerated()), id: \.offset) { index, road in
                step(marker: Text("\(index + 1)").font(.footnote.weight(.bold)).monospacedDigit(), title: road, trailing: nil)
            }
            step(marker: Image(systemName: "signpost.right.fill").font(.caption.weight(.bold)),
                 title: destination?.shortName ?? "Destination",
                 trailing: "\(GuidanceSheet.distance(route.distanceM)), \(ExitPicker.eta(route.etaMin))",
                 last: true)
            if let safety = route.safety {
                Label(safety.word, systemImage: safety.symbol)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(safety.tint)
                    .padding(.leading, 40)
                    .padding(.top, 2)
            }
        }
    }

    private func step(marker: some View, title: String, trailing: String?, last: Bool = false) -> some View {
        HStack(alignment: .center, spacing: 12) {
            marker
                .foregroundStyle(last ? Color.white : Color.ctRoute)
                .frame(width: 26, height: 26)
                .background {
                    if last { Circle().fill(Color.ctRoute) } else { Circle().strokeBorder(Color.ctRoute, lineWidth: 1.5) }
                }
                .frame(width: 28)
            Text(title)
                .font(last ? .body.weight(.semibold) : .body)
                .foregroundStyle(Color.ctInk)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            if let trailing {
                Text(trailing)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Color.ctInkMuted)
                    .monospacedDigit()
                    .multilineTextAlignment(.trailing)
                    .layoutPriority(1)
            }
        }
        .frame(minHeight: 40)
        .accessibilityElement(children: .combine)
    }
}

/// Responder task helpers shared by the sheet and the map.
extension LiveStore {
    private var openTasks: [CheckTask] {
        (situation?.tasks ?? tasks).filter { $0.status == .open || $0.status == .accepted }
    }

    /// The task to show: accepted first, then assigned to this device, then oldest. Nil for civilians.
    var currentTask: CheckTask? {
        guard role != .civilian else { return nil }
        let me = credential?.partyKey
        return openTasks.min { a, b in
            func rank(_ t: CheckTask) -> Int {
                if t.status == .accepted { return 0 }
                return t.assignee != nil && t.assignee == me ? 1 : 2
            }
            return rank(a) == rank(b) ? a.createdAt < b.createdAt : rank(a) < rank(b)
        }
    }

    var otherTaskCount: Int { max(0, openTasks.count - 1) }

    /// Where the task points: its coordinate, else a known hazard or report on its segment.
    func taskTarget(_ task: CheckTask) -> LonLat? {
        if let c = task.target.coord, c.isValid { return c }
        guard let id = task.target.segmentId else { return nil }
        return situation?.hazards.first { $0.roadRef?.segmentId == id }?.coord
            ?? allReports.first { $0.roadRef?.segmentId == id }?.location.coord
    }

    /// The road name for the task's segment, else "the marked place".
    func targetName(_ task: CheckTask) -> String {
        if let id = task.target.segmentId {
            let name = situation?.hazards.first { $0.roadRef?.segmentId == id }?.roadRef?.name
                ?? allReports.first { $0.roadRef?.segmentId == id }?.roadRef?.name
                ?? publicItems.first { $0.roadRef?.segmentId == id }?.roadRef?.name
            if let name { return name }
        }
        return "the marked place"
    }
}
