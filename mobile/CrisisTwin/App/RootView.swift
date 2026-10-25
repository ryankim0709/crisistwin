import SwiftUI

/// Debug builds accept launch arguments so every tab and state can be screenshotted:
/// - `-screen <name>`: a tab (`home`, `map`, `reports`, `plan`, `tasks`), or a screen opened on
///   top of one: `report` (the report sheet over Map), `newreport` (over Reports), and `family`,
///   `meeting`, `broadcast`, `responder`, `about` (pushed in Plan), `voice` (the voice sheet
///   over Home), and `drive` (the full-screen Drive mode over Home). Anything else opens Home.
/// - `-join <code>`: joins as a responder on launch, so the Tasks tab appears.
/// - `-start 1`: taps Start shortly after launch (Map, following).
/// - `detail` opens the guidance detail over Home (`detailexit` with the exits listed),
///   `detailmap` over Map; `exercise` opens Home's Exercise explanation.
/// - `-scroll bottom`: scrolls Home or the guidance detail to its end.
enum DebugLaunch {
    static var screen: String? { value("screen") }
    static var joinCode: String? { value("join") }
    /// `-joinlink <crisistwin://join?...>`: opens a join link on launch (simctl openurl asks first).
    static var joinLink: String? { value("joinlink") }
    static var start: Bool { value("start") == "1" }
    static var scrollToBottom: Bool { value("scroll") == "bottom" }

    private static func value(_ key: String) -> String? {
        #if DEBUG
        return UserDefaults.standard.string(forKey: key)
        #else
        return nil
        #endif
    }

    static var initialTab: AppTab {
        switch screen {
        case "map", "report", "detailmap": return .map
        case "reports", "newreport": return .reports
        case "plan", "family", "meeting", "broadcast", "responder", "about": return .plan
        case "tasks": return .tasks
        default: return .home
        }
    }
}

/// The tabs, plus `family`, which the resident-app views (Family, the web simulation feed) ask
/// to open; it and `plan` open inside the Plan tab.
enum AppTab: Hashable {
    case home, map, reports, plan, tasks
    case family
}

/// A request to open the report sheet, zooming from `sourceID`.
struct ReportRequest: Identifiable {
    let id = UUID()
    var prefill: ReportPrefill?
    var sourceID: String
}

/// Cross-tab navigation: the selected tab, the report sheet, and what Map does when it shows.
@MainActor
@Observable
final class AppRouter {
    var tab: AppTab = DebugLaunch.initialTab
    var report: ReportRequest? = DebugLaunch.screen == "report"
        ? ReportRequest(sourceID: "map-report")
        : DebugLaunch.screen == "newreport" ? ReportRequest(sourceID: "reports-new") : nil
    /// Map follows the device along the route, pitched (Start).
    var following = false
    /// A place Map flies to (a responder task); Map clears it once framed.
    var focus: LonLat?
    /// The guidance detail sheet (the Slab and the bottom accessory open it).
    var detail = false
    /// The voice assistant sheet.
    var voice = DebugLaunch.screen == "voice"
    /// Drive mode, the full-screen voice-first view.
    var drive = DebugLaunch.screen == "drive"

    /// Home's Start: Map, pitched, following the device.
    func start() {
        tab = .map
        following = true
    }

    func openDetail() {
        detail = true
    }

    func openVoice() {
        voice = true
    }

    func openDrive() {
        voice = false
        drive = true
    }

    func openReport(_ prefill: ReportPrefill? = nil, from sourceID: String) {
        report = ReportRequest(prefill: prefill, sourceID: sourceID)
    }

    func showOnMap(_ coord: LonLat?) {
        following = false
        focus = coord
        tab = .map
    }
}

private struct ReportZoomKey: EnvironmentKey {
    static let defaultValue: Namespace.ID? = nil
}

extension EnvironmentValues {
    /// The namespace the report sheet zooms out of (`matchedTransitionSource`).
    var reportZoom: Namespace.ID? {
        get { self[ReportZoomKey.self] }
        set { self[ReportZoomKey.self] = newValue }
    }
}

extension View {
    /// Marks a control the report sheet zooms out of.
    @ViewBuilder func reportZoomSource(_ id: String, in namespace: Namespace.ID?) -> some View {
        if let namespace { matchedTransitionSource(id: id, in: namespace) } else { self }
    }
}

/// The phone: Home (my area), Map, Reports, Plan, and Tasks for responders, with the live
/// guidance line in the bottom accessory on every tab (design spec, "Tabs").
struct RootView: View {
    @State private var planStore = MeetingPlanStore()
    /// Live situation, guidance, reports and check-ins (ADR 0011, 0012).
    @State private var liveStore = LiveStore()
    @State private var location = LocationProvider()
    /// The web pages' simulation broadcast (ADR 0016); polled only while its screen is open.
    @State private var broadcastStore = BroadcastStore()
    @State private var familyStore = FamilyStore()
    @State private var router = AppRouter()
    @State private var joinAlert: String?
    @Namespace private var reportZoom
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        tabs
            .environment(planStore)
            .environment(liveStore)
            .environment(location)
            .environment(broadcastStore)
            .environment(familyStore)
            .environment(router)
            .environment(\.reportZoom, reportZoom)
            .tint(.primary)
            .sheet(item: $router.report) { request in
                NavigationStack { ReportSheet(prefill: request.prefill) }
                    .presentationDetents([.large])
                    .navigationTransition(.zoom(sourceID: request.sourceID, in: reportZoom))
                    .environment(liveStore)
                    .environment(location)
            }
            .sheet(isPresented: $router.voice) {
                VoiceView()
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
                    .environment(liveStore)
                    .environment(location)
                    .environment(router)
                    .tint(.primary)
            }
            .fullScreenCover(isPresented: $router.drive) {
                DriveView()
                    .environment(liveStore)
                    .environment(location)
                    .environment(router)
                    .tint(.primary)
            }
            .sheet(isPresented: $router.detail) {
                GuidanceDetailView()
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
                    .environment(liveStore)
                    .environment(location)
                    .environment(router)
                    .environment(familyStore)
                    .tint(.primary)
            }
            .task(id: scenePhase) {
                guard scenePhase == .active else {
                    liveStore.stopPolling()
                    location.stopUpdating()
                    return
                }
                liveStore.startPolling()
                location.startUpdating()
                while !Task.isCancelled {
                    if familyStore.isJoined { await familyStore.refresh() }
                    try? await Task.sleep(for: FamilyStore.pollInterval)
                }
            }
            .onChange(of: router.following, initial: true) { _, following in liveStore.navigating = following }
            .onChange(of: location.lastLocation) { _, fix in
                if let fix { liveStore.observeFix(fix) }
                liveStore.updateLocation(
                    fix.map { LonLat(lon: $0.coordinate.longitude, lat: $0.coordinate.latitude) },
                    accuracyM: fix?.horizontalAccuracy)
            }
            // A family member changed the shared meeting points: use them on this phone too.
            // A new family whose points nobody has set yet leaves this phone's points alone.
            .onChange(of: familyStore.family?.meetingPointsUpdatedAt) {
                guard let family = familyStore.family, family.meetingPointsUpdatedBy != nil else { return }
                planStore.update { plan in
                    plan.primary = family.primary
                    plan.backup = family.backup
                }
            }
            // The one orchestrated moment, a new guidance version: warning on escalation, a
            // medium impact on a reroute (spec, "Motion and haptics").
            .sensoryFeedback(trigger: liveStore.guidanceChange?.id) { _, _ in
                guard let change = liveStore.guidanceChange else { return nil }
                return change.isEscalation ? .warning : .impact(weight: .medium)
            }
            .task(id: liveStore.guidanceChange?.id) {
                guard let change = liveStore.guidanceChange else { return }
                AccessibilityNotification.Announcement(
                    [change.message, change.detail].compactMap { $0 }.joined(separator: ". ")).post()
                try? await Task.sleep(for: .seconds(2))
                if !Task.isCancelled { liveStore.acknowledgeGuidanceChange() }
            }
            .onChange(of: liveStore.role) { _, role in
                if role == .civilian, router.tab == .tasks { router.tab = .home }
            }
            .sheet(isPresented: Binding(
                get: { liveStore.needsProfileSetup && joinAlert == nil }, set: { _ in })
            ) {
                FirstJoinSheet()
                    .interactiveDismissDisabled()
                    .environment(liveStore)
                    .environment(location)
                    .tint(.primary)
            }
            .task { await debugLaunch() }
            // crisistwin://join?server=<origin>&code=<invite> (ADR 0034).
            .onOpenURL { url in Task { await liveStore.joinFromURL(url) } }
            .alert("Server", isPresented: Binding(
                get: { joinAlert != nil }, set: { if !$0 { joinAlert = nil } })
            ) { Button("OK") { joinAlert = nil } } message: { Text(joinAlert ?? "") }
            .onChange(of: liveStore.joinNotice) { _, notice in joinAlert = notice }
    }

    @ViewBuilder private var tabs: some View {
        let view = TabView(selection: $router.tab) {
            Tab("Home", systemImage: "house", value: AppTab.home) {
                HomeView()
            }
            Tab("Map", systemImage: "map", value: AppTab.map) {
                IncidentView()
            }
            Tab("Reports", systemImage: "exclamationmark.bubble", value: AppTab.reports) {
                ReportsView()
            }
            .badge(liveStore.stillThereItems.count + liveStore.boardQuestions.count)
            Tab("Plan", systemImage: "list.bullet.clipboard", value: AppTab.plan) {
                PlanTab()
            }
            if liveStore.role != .civilian {
                Tab("Tasks", systemImage: "checklist", value: AppTab.tasks) {
                    TasksView()
                }
                .badge(liveStore.tasks.filter { $0.status == .open }.count)
            }
        }
        // The tab bar stays put while scrolling, so the tabs are always one tap away.
        .tabBarMinimizeBehavior(.never)

        // Attached only while there is guidance to carry; the selection is bound, so the
        // selected tab survives the accessory appearing or going.
        if let guidance = liveStore.activeGuidance {
            view.tabViewBottomAccessory {
                GuidanceAccessory(guidance: guidance, offline: liveStore.offlineSince != nil) {
                    router.openDetail()
                }
            }
        } else {
            view
        }
    }

    private func debugLaunch() async {
        #if DEBUG
        if let link = DebugLaunch.joinLink { await liveStore.joinFromText(link) }
        if let code = DebugLaunch.joinCode, liveStore.role == .civilian {
            try? await liveStore.joinAsResponder(inviteCode: code)
            if DebugLaunch.screen == "tasks" { router.tab = .tasks }
        }
        if ["detail", "detailexit", "detailmap"].contains(DebugLaunch.screen) {
            // Once guidance has loaded, so the sheet opens on real content.
            for _ in 0..<20 where liveStore.activeGuidance == nil {
                try? await Task.sleep(for: .milliseconds(250))
            }
            router.openDetail()
        }
        if DebugLaunch.start {
            try? await Task.sleep(for: .seconds(3))
            router.start()
        }
        #endif
    }
}
