import SwiftUI
import UIKit

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

/// Shared presentation helpers for guidance levels and drill time.
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
}

enum DrillTime {
    /// Drill times are shown in UTC, matching the server's fire labels ("16:30 drill time").
    static func hhmm(_ date: Date) -> String {
        formatter.string(from: date)
    }

    private static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "HH:mm"
        return f
    }()

    /// The drill clock advanced since the last poll at its speed. Not clamped to the clock's end;
    /// the next poll corrects it.
    static func now(_ drill: DrillClock, generatedAt: Date, wallNow: Date = Date()) -> Date {
        guard drill.running, drill.speed > 0 else { return drill.replayNow }
        return drill.replayNow.addingTimeInterval(max(0, wallNow.timeIntervalSince(generatedAt)) * drill.speed)
    }
}

/// The phone's one screen about the live incident (ADR 0012): full-bleed `IncidentMap`, a status
/// strip (zone and level), the drill chip, one persistent `GuidanceSheet`, the report button and
/// the `AppMenu` button. Reads `LiveStore` and `LocationProvider` from the environment.
struct IncidentView: View {
    /// Height of the sheet's small detent, above the bottom safe area; the map keeps its content
    /// clear of it.
    static let sheetHeight: CGFloat = 214

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
    @State private var sheetShown = true
    @State private var detent: PresentationDetent = .height(IncidentView.sheetHeight)
    @State private var modal: Modal? = IncidentView.initialModal
    @State private var following = false

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
        IncidentMap(situation: store.situation, myLocation: myLocation, guidance: store.myGuidance)
            .safeAreaPadding(.top, 56)
            .safeAreaPadding(.bottom, Self.sheetHeight)
            .overlay(alignment: .top) {
                VStack(spacing: 8) {
                    topBar
                    if let change = store.guidanceChange { banner(change) }
                }
                .padding(.horizontal, 12)
                .padding(.top, 4)
                .animation(.snappy(duration: 0.3), value: store.guidanceChange)
            }
            .overlay(alignment: .bottomTrailing) {
                reportButton
                    .padding(.trailing, 16)
                    .padding(.bottom, Self.sheetHeight + 12)
            }
            .environment(\.incidentActions, actions)
            .sheet(isPresented: $sheetShown) {
                GuidanceSheet()
                    .environment(\.incidentActions, actions)
                    .presentationDetents([.height(Self.sheetHeight), .medium], selection: $detent)
                    .presentationBackgroundInteraction(.enabled(upThrough: .medium))
                    .presentationBackground(Color.ctSurface)
                    .presentationCornerRadius(24)
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
            .task(id: store.guidanceChange?.id) {
                guard store.guidanceChange != nil else { return }
                UINotificationFeedbackGenerator().notificationOccurred(.warning)
                try? await Task.sleep(for: .seconds(8))
                if !Task.isCancelled { withAnimation { store.acknowledgeGuidanceChange() } }
            }
    }

    private func start() {
        store.startPolling()
        location.startUpdating()
    }

    private func stop() {
        store.stopPolling()
        location.stopUpdating()
    }

    // MARK: Top bar

    private var topBar: some View {
        HStack(spacing: 8) {
            Button {
                modal = .menu
            } label: {
                Image(systemName: "line.3.horizontal")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Color.ctInk)
                    .frame(width: 44, height: 44)
                    .background(Color.ctSurface, in: Circle())
                    .overlay(Circle().strokeBorder(Color.ctBorder.opacity(0.7), lineWidth: 1))
                    .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Menu")

            zoneStrip
            drillChip
        }
    }

    private var zoneTitle: String {
        if let zone = store.myZone { return zone.name }
        if !location.isAuthorized { return "Location off" }
        if location.lastLocation == nil { return "Locating" }
        if store.situation == nil {
            if case .unavailable = store.connection { return "Offline" }
            return "Connecting"
        }
        return "Outside drill zones"
    }

    private var zoneStrip: some View {
        HStack(spacing: 8) {
            Text(zoneTitle)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.ctInk)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 4)
            if store.myZone != nil {
                let level = store.myGuidance?.level ?? .none
                StatusPill(text: level.pillText, systemImage: level.pillImage, tone: level.tone)
                    .fixedSize()
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, 6)
        .frame(maxWidth: .infinity, minHeight: 44)
        .background(Color.ctSurface, in: Capsule())
        .overlay(Capsule().strokeBorder(Color.ctBorder.opacity(0.7), lineWidth: 1))
        .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
        .accessibilityElement(children: .combine)
    }

    private var drillChip: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let time = store.situation.map { DrillTime.now($0.drill, generatedAt: $0.generatedAt, wallNow: context.date) }
            HStack(spacing: 4) {
                Text("Drill")
                if let time {
                    Text(DrillTime.hhmm(time)).monospacedDigit()
                }
            }
            .font(.caption.weight(.bold))
            .foregroundStyle(HazardTone.caution.color)
            .padding(.horizontal, 10)
            .frame(minHeight: 44)
            .background(Color.ctSurface, in: Capsule())
            .overlay(Capsule().strokeBorder(HazardTone.caution.color.opacity(0.6), lineWidth: 1))
            .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(time.map { "Drill, not a real incident. Drill time \(DrillTime.hhmm($0)) UTC" }
                                ?? "Drill, not a real incident")
        }
    }

    private func banner(_ change: GuidanceChange) -> some View {
        Button {
            withAnimation { store.acknowledgeGuidanceChange() }
        } label: {
            Label(change.message, systemImage: "arrow.triangle.turn.up.right.diamond.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color(light: 0xFFFFFF, dark: 0x0E1A16))
                .multilineTextAlignment(.leading)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.ctInk, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .shadow(color: .black.opacity(0.2), radius: 10, y: 4)
        }
        .buttonStyle(.plain)
        .accessibilityHint("Dismisses")
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    private var reportButton: some View {
        Button {
            modal = .report(nil)
        } label: {
            Image(systemName: "exclamationmark.bubble.fill")
                .font(.title3.weight(.semibold))
                .foregroundStyle(Color(light: 0xFFFFFF, dark: 0x0E1A16))
                .frame(width: 56, height: 56)
                .background(Color.ctBrand, in: Circle())
                .shadow(color: .black.opacity(0.22), radius: 8, y: 3)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Report what you see")
    }
}

#Preview {
    IncidentView()
        .environment(LiveStore())
        .environment(LocationProvider())
        .environment(MeetingPlanStore())
}
