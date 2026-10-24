import Foundation
import Network
import Observation

/// Shared live state for the Live tab: credential, outbox, public map, own reports, and (for
/// responders) all reports and check tasks. Views read it from the environment.
///
/// Registers a civilian device lazily on first need. Location only leaves the device inside a
/// report or a prompts query.
@MainActor
@Observable
final class LiveStore {
    enum Connection: Equatable {
        case idle
        case connecting
        case online
        /// The service could not be reached or rejected the request; the message is user-facing.
        case unavailable(String)
    }

    let incidentId: String

    private(set) var credential: LiveCredential?
    private(set) var connection: Connection = .idle
    /// Reports saved on the device and not yet accepted by the server, oldest first.
    private(set) var pending: [ReportDraft] = []
    /// This device's accepted reports, newest first.
    private(set) var myReports: [FieldReport] = []
    /// Items that passed the public independence rules.
    private(set) var publicItems: [PublicMapItem] = []
    /// Responder and controller only; empty for civilians.
    private(set) var allReports: [FieldReport] = []
    /// Responder only: open check tasks assigned to this device.
    private(set) var tasks: [CheckTask] = []
    private(set) var lastRefreshed: Date?

    // MARK: v2 incident screen (ADR 0012). Stubs; implemented by the iosdata owner.

    /// Latest `GET incidents/{id}/situation`, with zones filled from the cache when the response
    /// omitted them (`?zones=0`). At launch, the last saved situation (`SituationCache`); nil
    /// until the first successful poll when none was saved.
    private(set) var situation: Situation?
    /// The zone containing the device's last known position, computed on the device with
    /// `ZoneLocator`. Nil without a position or outside every zone.
    private(set) var myZone: LiveZone?
    /// Published guidance for `myZone`; nil when the zone has none.
    var myGuidance: ZoneGuidance? {
        guard let zoneId = myZone?.id else { return nil }
        return situation?.guidance.first { $0.zoneId == zoneId }
    }
    /// Set when `myGuidance` gets a new version (or `myZone` changes to a zone with different
    /// guidance) after the first load; the UI shows a banner and plays a haptic, then calls
    /// `acknowledgeGuidanceChange()`.
    private(set) var guidanceChange: GuidanceChange?
    /// This device's latest check-in, from the server (`situation.myCheckin`) or the last `checkIn`.
    private(set) var lastCheckIn: CheckIn?
    /// Responder opt-in to share live location (latest position only, foreground only). Persisted
    /// on the device. Turning it off calls `DELETE me/location`. Ignored for civilians.
    var shareResponderLocation: Bool = UserDefaults.standard.bool(forKey: "live.shareResponderLocation") {
        didSet {
            UserDefaults.standard.set(shareResponderLocation, forKey: "live.shareResponderLocation")
            shareSettingChanged()
        }
    }

    @ObservationIgnored private let outbox = ReportOutbox()
    @ObservationIgnored private let monitor = NWPathMonitor()
    @ObservationIgnored private var networkSatisfied = true
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var registration: Task<LiveCredential, Error>?
    @ObservationIgnored private var refreshGeneration = 0
    /// Cursor for `GET incidents/{id}/reports?since=`; only advanced by a response that is applied.
    @ObservationIgnored private var reportsCursor: String?

    @ObservationIgnored private var zonesCache: (version: String, zones: [LiveZone])?
    @ObservationIgnored private var lastLocationSend: Date?
    @ObservationIgnored private(set) var lastCoord: LonLat?
    @ObservationIgnored private var locationWasShared = false
    @ObservationIgnored private var seenGuidance = false
    @ObservationIgnored private var lastSeenGuidance: ZoneGuidance?

    private static let pollInterval: Duration = .seconds(10)
    private static let locationInterval: TimeInterval = 30

    var role: LiveRole { credential?.role ?? .civilian }

    init(incidentId: String = LiveIncident.defaultId) {
        self.incidentId = incidentId
        credential = CredentialStore.load(.responder) ?? CredentialStore.load(.device)
        pending = outbox.drafts
        // The last situation, so a relaunch without signal still shows the last instruction.
        if let cached = SituationCache.load(incidentId: incidentId) { applySituation(cached, save: false) }
        outbox.onChange = { [weak self] in
            guard let self else { return }
            self.pending = self.outbox.drafts
        }
        monitor.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            Task { @MainActor in self?.networkChanged(satisfied: satisfied) }
        }
        monitor.start(queue: DispatchQueue(label: "crisistwin.live.network", qos: .utility))
    }

    deinit {
        monitor.cancel()
    }

    /// Saves the draft to the on-device outbox immediately, then tries to send it. Never loses a
    /// draft on network failure; it stays in `pending` until the server accepts it.
    func submit(_ draft: ReportDraft) {
        outbox.enqueue(draft)
        Task {
            if await flush(force: false) > 0 { await refresh() }
        }
    }

    /// Re-sends everything in `pending`.
    func flushOutbox() async {
        if await flush(force: true) > 0 { await refresh() }
    }

    /// Fetches the public map, own reports, and responder data for the current role.
    func refresh() async {
        refreshGeneration += 1
        let generation = refreshGeneration
        if connection == .idle { connection = .connecting }
        _ = await flush(force: false)
        if Task.isCancelled { return resetConnecting() }

        let incidentId = incidentId
        let sinceCursor = reportsCursor
        let wantsResponderData: Bool
        do {
            wantsResponderData = try await ensureCredential().role != .civilian
        } catch {
            return finishRefresh(generation, failure: error)
        }

        let cachedZones = zonesCache
        async let sit = fetch {
            try await $0.situation(incidentId: incidentId, includeZones: cachedZones == nil, token: $1)
        }
        async let mine = fetch { try await $0.myReports(token: $1) }
        async let page = wantsResponderData
            ? fetch { try await $0.reports(incidentId: incidentId, since: sinceCursor, token: $1) } : nil
        async let openTasks = wantsResponderData
            ? fetch { try await $0.myTasks(token: $1) } : nil
        let (sitResult, mineResult, pageResult, tasksResult) = await (sit, mine, page, openTasks)

        // A slower, older refresh must not overwrite a newer one.
        guard generation == refreshGeneration, !Task.isCancelled else { return resetConnecting() }
        var failure: Error?
        func take<T>(_ result: Result<T, Error>?, _ apply: (T) -> Void) {
            switch result {
            case .success(let value): apply(value)
            case .failure(let error): failure = failure ?? error
            case nil: break
            }
        }
        take(sitResult) { applySituation($0) }
        take(mineResult) { myReports = $0.sorted { $0.observedAt > $1.observedAt } }
        take(pageResult) { page in
            reportsCursor = page.nextCursor
            var byId = Dictionary(allReports.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
            for report in page.reports { byId[report.id] = report }
            allReports = byId.values.sorted { $0.observedAt > $1.observedAt }
        }
        take(tasksResult) { tasks = $0.filter { $0.status == .open || $0.status == .accepted }.sorted { $0.createdAt < $1.createdAt } }
        if let failure { return finishRefresh(generation, failure: failure) }
        connection = .online
        lastRefreshed = Date()
    }

    /// Refreshes while the Live tab is visible and the app is in the foreground.
    func startPolling() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: Self.pollInterval)
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    /// Exchanges an incident invite code for a responder credential.
    func joinAsResponder(inviteCode: String) async throws {
        let code = inviteCode.trimmingCharacters(in: .whitespacesAndNewlines)
        let issued: LiveCredential
        do {
            issued = try await LiveAPIClient.configured().join(incidentId: incidentId, inviteCode: code)
        } catch LiveAPIError.unauthorized, LiveAPIError.forbidden, LiveAPIError.notFound {
            throw JoinError.invalidCode
        }
        guard issued.role != .civilian else { throw JoinError.invalidCode }
        CredentialStore.save(issued, slot: .responder)
        credential = issued
        resetResponderData()
        Task { await refresh() }
    }

    /// Drops the responder credential and returns to a civilian device credential.
    func leaveResponderRole() {
        CredentialStore.delete(.responder)
        credential = CredentialStore.load(.device)
        resetResponderData()
        Task { await refresh() }
    }

    /// Nearby items to ask "still there?" about. Sends the coordinate; it is not stored.
    func prompts(near coord: LonLat) async throws -> [PublicMapItem] {
        let incidentId = incidentId
        return try await authorized { try await $0.prompts(incidentId: incidentId, near: coord, token: $1) }
    }

    /// Feeds the device position from `LocationProvider`. Updates `myZone` on the device and, for
    /// a responder with `shareResponderLocation` on, posts `me/location` at most every 30 s.
    /// Civilian positions are never sent from here.
    func updateLocation(_ coord: LonLat?, accuracyM: Double? = nil) {
        lastCoord = coord
        let zone = coord.flatMap { c in situation?.zones.flatMap { ZoneLocator.zone(containing: c, in: $0) } }
        setZone(zone)
        guard let coord, role == .responder, shareResponderLocation else { return }
        let now = Date()
        if let last = lastLocationSend, now.timeIntervalSince(last) < Self.locationInterval { return }
        lastLocationSend = now
        locationWasShared = true
        Task {
            do {
                let update = ResponderLocationUpdate(coord: coord, accuracyM: accuracyM, at: now)
                try await authorized { try await $0.updateLocation(update, token: $1) }
            } catch {
                lastLocationSend = nil  // retry on the next fix
            }
        }
    }

    /// Clears `guidanceChange` once the banner has been shown.
    func acknowledgeGuidanceChange() {
        guidanceChange = nil
    }

    /// Posts a check-in for `myZone`. `needHelp` attaches the last known position (the only
    /// time a civilian position leaves the phone outside a report); other statuses never do.
    /// Sets `lastCheckIn` on success.
    func checkIn(_ status: CheckInStatus) async throws {
        let incidentId = incidentId
        // Only need_help carries a position; anything else never does.
        let request = CheckInRequest(
            status: status, zoneId: myZone?.id, coord: status == .needHelp ? lastCoord : nil)
        lastCheckIn = try await authorized {
            try await $0.checkIn(incidentId: incidentId, request: request, token: $1)
        }
    }

    /// Accepts a check task (`POST tasks/{id}` with `accepted`); the task stays in `tasks` with
    /// status `accepted`. Throws on 409 when another responder took it.
    func acceptTask(_ task: CheckTask) async throws {
        let accepted = try await authorized { try await $0.acceptTask(id: task.id, token: $1) }
        if let i = tasks.firstIndex(where: { $0.id == task.id }) { tasks[i] = accepted } else { tasks.append(accepted) }
    }

    /// Marks a task as not completed (for example, the place could not be reached).
    func cancelTask(_ task: CheckTask, note: String) async throws {
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        try await authorized {
            try await $0.updateTask(id: task.id, status: .cancelled, note: trimmed.isEmpty ? nil : trimmed, token: $1)
        }
        tasks.removeAll { $0.id == task.id }
    }

    private enum JoinError: LocalizedError {
        case invalidCode

        var errorDescription: String? { "That invite code wasn't accepted." }
    }

    private func applySituation(_ new: Situation, save: Bool = true) {
        var sit = new
        if let zones = new.zones {
            zonesCache = (new.zonesVersion, zones)
        } else if let cache = zonesCache, cache.version == new.zonesVersion {
            sit.zones = cache.zones
        } else {
            zonesCache = nil  // version moved without zones; refetch them next poll
        }
        situation = sit
        if save { SituationCache.save(sit) }
        publicItems = sit.hazards
        if let mine = sit.myCheckin { lastCheckIn = mine }
        if role == .responder { tasks = sit.tasks.filter { $0.status == .open || $0.status == .accepted } }
        let zone = lastCoord.flatMap { c in sit.zones.flatMap { ZoneLocator.zone(containing: c, in: $0) } }
        setZone(zone, force: true)
    }

    /// Sets `myZone` and raises `guidanceChange` when the guidance for it changed after the first load.
    private func setZone(_ zone: LiveZone?, force: Bool = false) {
        if zone != myZone { myZone = zone } else if !force { return }
        let current = myGuidance
        // The baseline is the first guidance resolved from a real position, so a relaunch that
        // shows the cached instruction does not announce it as a change.
        let resolvable = lastCoord != nil && situation?.zones != nil
        defer { if resolvable { lastSeenGuidance = current; seenGuidance = true } }
        guard seenGuidance, let current, current != lastSeenGuidance else { return }
        let before = lastSeenGuidance
        guard before?.zoneId != current.zoneId || before?.version != current.version else { return }
        if before?.level == current.level, before?.destination?.id == current.destination?.id,
           before?.route?.via == current.route?.via, before?.zoneId == current.zoneId { return }
        let isReroute = before?.zoneId == current.zoneId && before?.level == current.level
        let message = Self.changeMessage(current, before: before, isReroute: isReroute)
        let reason = current.reason.trimmingCharacters(in: .whitespacesAndNewlines)
        guidanceChange = GuidanceChange(
            id: "\(current.zoneId)#\(current.version)", message: message,
            detail: reason.isEmpty || reason == message ? nil : reason, level: current.level,
            isReroute: isReroute,
            isEscalation: current.level == .evacuateNow && before?.level != .evacuateNow)
    }

    /// What changed, instruction first: "Evacuate now · Leave via Skyway Road", "Be ready",
    /// "New route: Exit west", "Order lifted".
    private static func changeMessage(_ g: ZoneGuidance, before: ZoneGuidance?, isReroute: Bool) -> String {
        let leave = g.noRoute || g.route == nil ? "No open route" : g.route?.via.first.map { "Leave via \($0)" }
        if isReroute {
            if g.level == .evacuateNow, g.noRoute || g.route == nil { return "Evacuate now · No open route" }
            if let name = g.destination?.shortName, name != before?.destination?.shortName { return "New route: \(name)" }
            if let road = g.route?.via.first { return "New route: Leave via \(road)" }
            return "New route"
        }
        switch g.level {
        case .evacuateNow: return ["Evacuate now", leave].compactMap { $0 }.joined(separator: " · ")
        case .beReady: return "Be ready"
        case .none: return before?.zoneId == g.zoneId ? "Order lifted" : "No order"
        }
    }

    private func shareSettingChanged() {
        guard !shareResponderLocation, locationWasShared else { return }
        locationWasShared = false
        lastLocationSend = nil
        Task { try? await authorized { try await $0.clearLocation(token: $1) } }
    }

    private func resetResponderData() {
        allReports = []
        tasks = []
        reportsCursor = nil
    }

    private func resetConnecting() {
        if connection == .connecting { connection = .idle }
    }

    private func finishRefresh(_ generation: Int, failure: Error) {
        guard generation == refreshGeneration else { return }
        if failure is CancellationError || Task.isCancelled { return resetConnecting() }
        connection = .unavailable(failure.localizedDescription)
    }

    private func networkChanged(satisfied: Bool) {
        let wasSatisfied = networkSatisfied
        networkSatisfied = satisfied
        guard satisfied, !wasSatisfied else { return }
        Task {
            if pollTask != nil {
                await refresh()
            } else if await flush(force: false) > 0 {
                await refresh()
            }
        }
    }

    /// Flushes the outbox. Returns how many drafts the server accepted.
    private func flush(force: Bool) async -> Int {
        await outbox.flush(force: force) { [self] draft in
            do {
                try await authorized { try await $0.submit(draft, token: $1) }
                if case .unavailable = connection { connection = .online }
                return .accepted
            } catch is CancellationError {
                return .cancelled
            } catch LiveAPIError.rejected {
                return .rejected
            } catch {
                connection = .unavailable(error.localizedDescription)
                return .retryLater
            }
        }
    }

    private func fetch<T>(_ call: (LiveAPIClient, String) async throws -> T) async -> Result<T, Error> {
        do { return .success(try await authorized(call)) } catch { return .failure(error) }
    }

    /// Runs a call with the current bearer token, registering a civilian device first if there is
    /// none. On 401 the rejected credential is dropped and the call is retried once.
    private func authorized<T>(_ call: (LiveAPIClient, String) async throws -> T) async throws -> T {
        let client = try LiveAPIClient.configured()
        var retried = false
        while true {
            let used = try await ensureCredential()
            do {
                return try await call(client, used.token)
            } catch LiveAPIError.unauthorized where !retried {
                retried = true
                drop(used)
            }
        }
    }

    private func drop(_ rejected: LiveCredential) {
        guard credential == rejected else { return }  // another request already replaced it
        if rejected.role == .civilian {
            CredentialStore.delete(.device)
            credential = nil
        } else {
            CredentialStore.delete(.responder)
            credential = CredentialStore.load(.device)
            resetResponderData()
        }
    }

    private func ensureCredential() async throws -> LiveCredential {
        if let credential { return credential }
        if let registration { return try await registration.value }
        let task = Task { [self] () throws -> LiveCredential in
            defer { registration = nil }
            let issued = try await LiveAPIClient.configured().registerDevice()
            CredentialStore.save(issued, slot: .device)
            if credential == nil { credential = issued }
            return credential ?? issued
        }
        registration = task
        return try await task.value
    }
}
