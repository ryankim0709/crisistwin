import SwiftUI

/// Actions the incident screen hands to its sheet and map, so each control has one owner.
struct IncidentActions {
    /// Opens the report sheet, optionally prefilled (a task answer).
    var openReport: (ReportPrefill?) -> Void = { _ in }
    /// Turns follow mode (camera on the device and its route) on or off.
    var setFollowing: (Bool) -> Void = { _ in }
    var following = false
}

private struct IncidentActionsKey: EnvironmentKey {
    static let defaultValue = IncidentActions()
}

extension EnvironmentValues {
    var incidentActions: IncidentActions {
        get { self[IncidentActionsKey.self] }
        set { self[IncidentActionsKey.self] = newValue }
    }
}

/// Shared presentation helpers for guidance levels.
extension GuidanceLevel {
    var pillText: String {
        switch self {
        case .evacuateNow: return "Evacuate now"
        case .beReady: return "Be ready"
        case .none: return "No order"
        }
    }

    var pillImage: String {
        switch self {
        case .evacuateNow: return "exclamationmark.triangle.fill"
        case .beReady: return "clock.fill"
        case .none: return "minus.circle"
        }
    }

    var tone: HazardTone {
        switch self {
        case .evacuateNow: return .danger
        case .beReady: return .caution
        case .none: return .info
        }
    }

    /// Status band fill; `nil` is the neutral band (surface with a hairline border).
    var bandColor: Color? {
        switch self {
        case .evacuateNow: return .ctBandEvacuate
        case .beReady: return .ctBandReady
        case .none: return nil
        }
    }

    /// Text on the status band: white on red and dark on amber in both modes.
    var bandText: Color {
        switch self {
        case .evacuateNow: return .white
        case .beReady: return .ctBandReadyText
        case .none: return .ctInk
        }
    }
}

extension FireEstimate {
    /// Method and age on the incident clock, e.g. "Model estimate · 12 min ago".
    func displayLabel(now: Date) -> String {
        let method: String
        switch self.method {
        case .modelNowcast: method = "Model estimate"
        case .satellitePerimeter: method = "Satellite perimeter"
        case .none: return label
        }
        guard let asOf else { return method }
        return "\(method) · \(RelativeAge.text(from: asOf, to: now))"
    }
}

/// The phone's one screen about the live incident (ADR 0012): full-bleed `IncidentMap` under a
/// status band (menu, level, zone, Exercise tag when not real), the fire chip, one persistent
/// `GuidanceSheet` sized to its content, and the Report button. Reads `LiveStore` and
/// `LocationProvider` from the environment.
struct IncidentView: View {
    /// Sheet height before the content is measured, and the most it grows to (it scrolls beyond).
    static let initialSheetHeight: CGFloat = 248
    static let maxSheetHeight: CGFloat = 560
    /// Status band height and its inset from the screen edges.
    static let bandHeight: CGFloat = 56
    static let inset: CGFloat = 12

    private enum Modal: Identifiable {
        case menu
        case report(ReportPrefill?)

        var id: String {
            switch self {
            case .menu: return "menu"
            case .report: return "report"
            }
        }
    }

    @Environment(LiveStore.self) private var store
    @Environment(LocationProvider.self) private var location
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var sheetShown = true
    /// Measured content height of the sheet; its only detent.
    @State private var sheetHeight: CGFloat = IncidentView.initialSheetHeight
    @State private var modal: Modal? = IncidentView.initialModal
    @State private var following = false
    @State private var fireExpanded = false

    init() {}

    private static var initialModal: Modal? {
        switch DebugLaunch.screen {
        case "report": return .report(nil)
        case "menu", "myreports", "responder", "plan", "about": return .menu
        default: return nil
        }
    }

    private var myLocation: LonLat? {
        location.lastLocation.map { LonLat(lon: $0.coordinate.longitude, lat: $0.coordinate.latitude) }
    }

    private var actions: IncidentActions {
        IncidentActions(
            openReport: { modal = .report($0) },
            setFollowing: { on in withAnimation(.snappy) { following = on } },
            following: following)
    }


    var body: some View {
        IncidentMap(
            situation: store.situation, myLocation: myLocation, guidance: store.myGuidance?.withShortDestinationName,
            zone: store.myZone, task: store.currentTask, taskTarget: store.currentTask.flatMap(store.taskTarget))
            .safeAreaPadding(.top, Self.bandHeight + 52)
            .safeAreaPadding(.bottom, sheetHeight)
            .overlay(alignment: .top) { topStack }
            .overlay(alignment: .bottomTrailing) {
                reportButton
                    .padding(.trailing, Self.inset)
                    .padding(.bottom, sheetHeight + 12)
                    .animation(reduceMotion ? nil : .smooth, value: sheetHeight)
            }
            .environment(\.incidentActions, actions)
            .sheet(isPresented: $sheetShown) {
                GuidanceSheet { height in
                    let fitted = min(Self.maxSheetHeight, height.rounded(.up))
                    guard abs(fitted - sheetHeight) > 1 else { return }
                    withAnimation(reduceMotion ? nil : .smooth) { sheetHeight = fitted }
                }
                    .environment(\.incidentActions, actions)
                    .presentationDetents([.height(sheetHeight)])
                    .presentationBackgroundInteraction(.enabled(upThrough: .height(sheetHeight)))
                    .presentationBackground(Color.ctSurface)
                    .presentationCornerRadius(28)
                    .presentationDragIndicator(.visible)
                    .interactiveDismissDisabled()
                    // Other screens open from inside the persistent sheet: the screen behind it
                    // cannot present while the sheet is up.
                    .sheet(item: $modal) { modal in
                        switch modal {
                        case .menu:
                            AppMenu()
                                .environment(\.incidentActions, actions)
                        case .report(let prefill):
                            NavigationStack { ReportSheet(prefill: prefill) }
                        }
                    }
            }
            .onAppear(perform: start)
            .onDisappear(perform: stop)
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { start() } else { stop() }
            }
            .onChange(of: location.lastLocation) { _, fix in
                store.updateLocation(
                    fix.map { LonLat(lon: $0.coordinate.longitude, lat: $0.coordinate.latitude) },
                    accuracyM: fix?.horizontalAccuracy)
            }
            .sensoryFeedback(trigger: store.guidanceChange?.id) { _, _ in
                guard let change = store.guidanceChange else { return nil }
                return change.isEscalation ? .error : .warning
            }
            .task(id: store.guidanceChange?.id) {
                guard let change = store.guidanceChange else { return }
                AccessibilityNotification.Announcement(
                    [change.message, change.detail].compactMap { $0 }.joined(separator: ". ")).post()
                try? await Task.sleep(for: .seconds(8))
                if !Task.isCancelled { dismissBanner() }
            }
            .task { await debugJoin() }
    }

    private func start() {
        store.startPolling()
        location.startUpdating()
    }

    private func stop() {
        store.stopPolling()
        location.stopUpdating()
    }

    private func debugJoin() async {
        #if DEBUG
        if let code = DebugLaunch.joinCode, store.role == .civilian {
            try? await store.joinAsResponder(inviteCode: code)
        }
        #endif
    }

    private func dismissBanner() {
        withAnimation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(duration: 0.35, bounce: 0.15)) {
            store.acknowledgeGuidanceChange()
        }
    }

    // MARK: Top: band, then the banner or the fire chip

    private var topStack: some View {
        VStack(alignment: .leading, spacing: 8) {
            StatusBand(
                level: bandLevel, state: bandState, zoneName: store.myZone?.name,
                offlineSince: offlineSince, isExercise: store.situation?.incident?.isExercise == true,
                openMenu: { modal = .menu })
            if let change = store.guidanceChange {
                banner(change)
            } else if let fire = store.situation?.fire, fire.method != .none {
                fireChip(fire)
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, Self.inset)
        .padding(.top, 4)
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(duration: 0.35, bounce: 0.15),
                   value: store.guidanceChange)
    }

    /// The published level for the device's zone; nil before a zone is known or while it has no
    /// guidance yet.
    private var bandLevel: GuidanceLevel? {
        guard store.myZone != nil else { return nil }
        return store.myGuidance?.level
    }

    /// What the band says in place of the level.
    private var bandState: StatusBand.State {
        if !location.isAuthorized { return .locationOff }
        if store.situation == nil {
            if case .unavailable = store.connection { return .offline }
            return .connecting
        }
        if location.lastLocation == nil { return .locating }
        return store.myZone != nil ? .noInstruction : .outsideZones
    }

    /// The last successful update while the service is unreachable; nil when online.
    private var offlineSince: Date? {
        guard case .unavailable = store.connection else { return nil }
        return store.situation?.generatedAt
    }

    private func banner(_ change: GuidanceChange) -> some View {
        let tone: Color = change.isReroute ? .ctRoute : (change.level.bandColor ?? .ctInk)
        let icon = change.isReroute ? "arrow.triangle.turn.up.right.diamond.fill"
            : change.level == .none ? "checkmark.circle.fill" : change.level.pillImage
        return Button(action: dismissBanner) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.title3)
                    .foregroundStyle(tone)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(change.message)
                        .font(.headline)
                        .foregroundStyle(Color.ctInk)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    if let detail = change.detail {
                        // The reason only when it fits on one line.
                        ViewThatFits(in: .horizontal) {
                            Text(detail).fixedSize()
                            Color.clear.frame(width: 0, height: 0)
                        }
                        .font(.subheadline)
                        .foregroundStyle(Color.ctMuted)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.leading, 16)
            .padding(.trailing, 14)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
            .background(alignment: .leading) {
                Rectangle().fill(tone).frame(width: 4)
            }
            .background(Color.ctSurface)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .ctFloatShadow()
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([change.message, change.detail].compactMap { $0 }.joined(separator: ". "))
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Dismisses")
        .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
    }

    /// One fixed chip naming how the fire estimate was made and its age on the incident clock;
    /// tap for "Not a forecast."
    private func fireChip(_ fire: FireEstimate) -> some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            fireChipButton(fire, label: fire.displayLabel(now: store.situation?.incidentNow(at: context.date) ?? context.date))
        }
    }

    private func fireChipButton(_ fire: FireEstimate, label: String) -> some View {
        Button {
            withAnimation(reduceMotion ? nil : .snappy(duration: 0.2)) { fireExpanded.toggle() }
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Image(systemName: "flame.fill").foregroundStyle(Color.ctFire)
                    Text(label)
                        .foregroundStyle(Color.ctInk)
                        .monospacedDigit()
                }
                .font(.footnote.weight(.semibold))
                if fireExpanded {
                    Text("Not a forecast.")
                        .font(.footnote)
                        .foregroundStyle(Color.ctMuted)
                        .padding(.leading, 22)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, fireExpanded ? 8 : 0)
            .frame(minHeight: 36)
            .background(Color.ctSurface, in: RoundedRectangle(cornerRadius: fireExpanded ? 14 : 18, style: .continuous))
            .ctFloatShadow()
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(fireExpanded ? "\(label). Not a forecast." : label)
        .accessibilityHint(fireExpanded ? "" : "Shows what the estimate is")
    }

    private var reportButton: some View {
        Button {
            modal = .report(nil)
        } label: {
            Label("Report", systemImage: "exclamationmark.bubble.fill")
                .font(.headline)
                .foregroundStyle(Color.ctSurface)
                .padding(.horizontal, 20)
                .frame(height: 52)
                .background(Color.ctInk, in: Capsule())
                .ctFloatShadow()
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Report what you see")
    }
}

/// The top band: menu, the level as colour, icon and word, the zone, and the Exercise tag. The
/// only place the level and offline status show.
struct StatusBand: View {
    enum State {
        case locating, locationOff, connecting, offline, outsideZones
        /// In a zone that has no published guidance yet (not the same as an order of none).
        case noInstruction

        var text: String {
            switch self {
            case .locating: return "Locating"
            case .locationOff: return "Location off"
            case .connecting: return "Connecting"
            case .offline: return "Offline"
            case .outsideZones: return "Outside zones"
            case .noInstruction: return "No instruction yet"
            }
        }

        var systemImage: String {
            switch self {
            case .locating: return "location"
            case .locationOff: return "location.slash"
            case .connecting: return "antenna.radiowaves.left.and.right"
            case .offline: return "wifi.slash"
            case .outsideZones: return "mappin.slash"
            case .noInstruction: return "circle.dashed"
            }
        }
    }

    /// Nil before a zone is known; `state` is shown instead.
    let level: GuidanceLevel?
    let state: State
    let zoneName: String?
    /// Last update while offline; nil when online.
    let offlineSince: Date?
    let isExercise: Bool
    let openMenu: () -> Void

    private var ink: Color { (level ?? .none).bandText }
    private var word: String { level?.pillText ?? state.text }
    private var icon: String { level?.pillImage ?? state.systemImage }

    var body: some View {
        HStack(spacing: 6) {
            Button(action: openMenu) {
                Image(systemName: "line.3.horizontal")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(ink)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Menu")

            summary
        }
        .padding(.leading, 4)
        .padding(.trailing, 12)
        .frame(maxWidth: .infinity, minHeight: IncidentView.bandHeight)
        .background {
            let shape = RoundedRectangle(cornerRadius: 16, style: .continuous)
            if let fill = level?.bandColor {
                shape.fill(fill)
            } else {
                shape.fill(Color.ctSurface).overlay(shape.strokeBorder(Color.ctBorder, lineWidth: 1))
            }
        }
        .ctFloatShadow()
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
        .animation(.easeInOut(duration: 0.25), value: level)
    }

    private var summary: some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.headline)
                .contentTransition(.symbolEffect(.replace))
            Text(word.uppercased())
                .font(.title3.weight(.heavy))
                .tracking(0.5)
                .lineLimit(1)
                .minimumScaleFactor(0.85)
                .layoutPriority(1)
            Spacer(minLength: 4)
            if let offlineSince {
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    HStack(spacing: 4) {
                        Image(systemName: "wifi.slash")
                        Text(RelativeAge.text(from: offlineSince, to: context.date))
                            .monospacedDigit()
                            .lineLimit(1)
                    }
                    .font(.footnote.weight(.semibold))
                    .fixedSize()
                }
            } else if let zoneName {
                // A lone "…" says nothing: show the name when at least a readable part fits.
                ViewThatFits(in: .horizontal) {
                    Text(zoneName).fixedSize()
                    Text(zoneName).truncationMode(.tail).frame(maxWidth: 120, alignment: .trailing)
                    Color.clear.frame(width: 0, height: 0)
                }
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
            }
            if isExercise {
                Text("EXERCISE")
                    .font(.caption2.weight(.heavy))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .overlay(Capsule().strokeBorder(ink, lineWidth: 1.5))
                    .fixedSize()
            }
        }
        .foregroundStyle(ink)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
        .accessibilityAddTraits(.isHeader)
    }

    private var accessibilityText: String {
        var parts = [level?.pillText ?? state.text]
        if let offlineSince {
            parts.append("offline, last update \(RelativeAge.text(from: offlineSince, to: Date()))")
        } else if let zoneName {
            parts.append(zoneName)
        }
        if isExercise { parts.append("exercise") }
        return parts.joined(separator: ", ")
    }
}

#Preview {
    IncidentView()
        .environment(LiveStore())
        .environment(LocationProvider())
        .environment(MeetingPlanStore())
}
