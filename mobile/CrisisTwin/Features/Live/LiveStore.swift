import CoreLocation
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

    private(set) var incidentId: String
    /// The outcome of the last join link or QR code, for one line in About and an alert.
    var joinNotice: String?

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
    /// Responder only: the latest `GET tasks/{id}/route` per accepted task (simulated model output).
    private(set) var taskRoutes: [String: TaskRouteResponse] = [:]
    private(set) var lastRefreshed: Date?

    // MARK: v2 incident screen (ADR 0012). Stubs; implemented by the iosdata owner.

    /// Latest `GET incidents/{id}/situation`, with zones filled from the cache when the response
    /// omitted them (`?zones=0`). At launch, the last saved situation (`SituationCache`); nil
    /// until the first successful poll when none was saved.
    private(set) var situation: Situation?
    /// The zone containing the device's last known position, computed on the device with
    /// `ZoneLocator`. Nil without a position or outside every zone.
    private(set) var myZone: LiveZone?
    /// Guidance for `myZone` as this phone follows it: the published guidance with the person's
    /// destination choice (D1) applied, so the route line and "Via ..." headline follow the pick
    /// everywhere. Nil when the zone has none. `publishedGuidance` is the controller's version.
    var myGuidance: ZoneGuidance? {
        guard let zoneId = myZone?.id, let published = publishedGuidance else { return nil }
        return published.choosing(chosenDestinationId(for: zoneId))
    }
    /// The guidance published for `myZone`, without the person's choice; nil when there is none.
    var publishedGuidance: ZoneGuidance? {
        myZone.flatMap { publishedGuidance(for: $0.id) }
    }
    /// D1: destinations this phone chose, by zone id. Persisted; dropped when the pick expires or
    /// a new guidance version no longer offers it. No entry means the recommended destination.
    private(set) var destinationChoices: [String: StoredDestinationChoice] = [:]
    /// Zones whose pick a guidance version withdrew, with that version: the phone says so in
    /// one line until the person picks again or the next version arrives.
    private(set) var withdrawnChoices: [String: Int] = [:]
    /// Set when `myGuidance` gets a new version (or `myZone` changes to a zone with different
    /// guidance) after the first load; the UI shows a banner and plays a haptic, then calls
    /// `acknowledgeGuidanceChange()`.
    private(set) var guidanceChange: GuidanceChange?
    /// Earlier versions of this device's zone guidance seen on this phone, newest first (Home's
    /// Changes). Kept in memory only.
    private(set) var guidanceHistory: [GuidanceHistoryEntry] = []
    /// This device's latest check-in, from the server (`situation.myCheckin`) or the last `checkIn`.
    private(set) var lastCheckIn: CheckIn?
    /// "Still there?" items answered or set aside on this phone.
    private(set) var answeredStillThere: Set<String> = []
    /// Responder opt-in to share live location (latest position only, foreground only). Persisted
    /// on the device. Turning it off calls `DELETE me/location`. Ignored for civilians.
    var shareResponderLocation: Bool = UserDefaults.standard.bool(forKey: "live.shareResponderLocation") {
        didSet {
            UserDefaults.standard.set(shareResponderLocation, forKey: "live.shareResponderLocation")
            shareSettingChanged()
        }
    }

    /// The board's selected questions for this phone (civilians), best first, plus a stall question.
    /// Chosen on the device from the public board; see `BoardSelector`.
    private(set) var boardQuestions: [BoardQuestion] = []
    /// Set by the Map while it follows the device along the route (the person is navigating).
    var navigating = false {
        didSet { if navigating != oldValue { navigationChanged() } }
    }
    /// Per-device opt-in: send `road_passable` / `heavy_traffic` passively for board roads driven
    /// through while navigating. Off by default; nothing else leaves the phone.
    var shareRoadObservations: Bool = UserDefaults.standard.bool(forKey: LiveStore.shareRoadObservationsKey) {
        didSet {
            UserDefaults.standard.set(shareRoadObservations, forKey: Self.shareRoadObservationsKey)
            passive.reset()
            updateTracking()
        }
    }
    static let shareRoadObservationsKey = "shareRoadObservations"

    @ObservationIgnored private var board = BoardResponse()
    @ObservationIgnored private var boardAnswered: [String: Date] = LiveStore.loadBoardAnswered()
    @ObservationIgnored private var stallQuestions: [String: BoardItem] = [:]
    @ObservationIgnored private var passive = PassiveTraversal()
    @ObservationIgnored private var stall = StallDetector()
    @ObservationIgnored private var selectedBoardItems: [BoardItem] = []
    @ObservationIgnored private var boardComputedAt: LonLat?
    @ObservationIgnored private let outbox = ReportOutbox()
    @ObservationIgnored private let monitor = NWPathMonitor()
    @ObservationIgnored private var networkSatisfied = true
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var registration: Task<LiveCredential, Error>?
    @ObservationIgnored private var refreshGeneration = 0
    /// Cursor for `GET incidents/{id}/reports?since=`; only advanced by a response that is applied.
    @ObservationIgnored private var reportsCursor: String?
    /// Set by a situation 404; makes the poll loop re-read `GET /api/live/active` at once.
    @ObservationIgnored private var activeCheckWanted = false
    @ObservationIgnored private var lastActiveCheck = Date()

    @ObservationIgnored private var zonesCache: (version: String, zones: [LiveZone])?
    @ObservationIgnored private var lastLocationSend: Date?
    @ObservationIgnored private(set) var lastCoord: LonLat?
    @ObservationIgnored private var locationWasShared = false
    @ObservationIgnored private var seenGuidance = false
    @ObservationIgnored private var lastSeenGuidance: ZoneGuidance?
    @ObservationIgnored private var routeFetchedAt: [String: Date] = [:]
    @ObservationIgnored private var routesInFlight: Set<String> = []

    // Matches the /live console's 3 s poll so an approval reaches the phone within seconds.
    private static let pollInterval: Duration = .seconds(3)
    private static let locationInterval: TimeInterval = 30
    /// A task's route is refetched with the poll, at most this often.
    private static let routeInterval: TimeInterval = 15
    /// How often the poll loop re-reads which incident the server runs.
    private static let activeInterval: TimeInterval = 60

    var role: LiveRole { credential?.role ?? .civilian }

    init(incidentId: String = LiveIncident.currentId) {
        self.incidentId = incidentId
        credential = CredentialStore.load(.responder) ?? CredentialStore.load(.device)
        destinationChoices = Self.loadChoices(incidentId: incidentId)
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

    // MARK: Your reports: edit and delete

    /// Replaces an unsent draft on the phone (no network), then tries to send it.
    func updateDraft(_ draft: ReportDraft) throws {
        guard outbox.update(draft) else { throw ReportChangeError.sending }
        Task {
            if await flush(force: false) > 0 { await refresh() }
        }
    }

    /// Removes an unsent draft from the phone; nothing is sent.
    func deleteDraft(_ draft: ReportDraft) throws {
        guard outbox.remove(clientId: draft.clientId) else { throw ReportChangeError.sending }
    }

    /// Edits one of this phone's sent reports (`PATCH me/reports/{id}`), then refreshes. Only
    /// while it is unverified or corroborated; otherwise throws `LiveAPIError.reportLocked`.
    func editReport(_ report: FieldReport, patch: ReportPatch) async throws {
        guard !patch.isEmpty else { return }
        let updated = try await changeOwnReport { try await $0.editReport(id: report.id, patch: patch, token: $1) }
        updateMine { mine in
            if let index = mine.firstIndex(where: { $0.id == updated.id }) { mine[index] = updated }
        }
    }

    /// Deletes one of this phone's sent reports. The server keeps it as `withdrawn` for the
    /// record and drops it from this phone's list; same lock as `editReport`.
    func withdrawReport(_ report: FieldReport) async throws {
        _ = try await changeOwnReport { try await $0.withdrawReport(id: report.id, token: $1) }
        updateMine { $0.removeAll { $0.id == report.id } }
    }

    /// Runs an edit or withdrawal. A locked or missing report refreshes the list, so the phone
    /// shows what the server has, and rethrows in words for the person.
    private func changeOwnReport(_ call: (LiveAPIClient, String) async throws -> FieldReport) async throws -> FieldReport {
        do {
            return try await authorized(call)
        } catch LiveAPIError.reportLocked {
            Task { await refresh() }
            throw LiveAPIError.reportLocked
        } catch LiveAPIError.notFound {
            Task { await refresh() }
            throw ReportChangeError.gone
        }
    }

    /// Applies a change to `myReports` at once, so a poll already in flight cannot put the old
    /// list back, then refreshes from the server.
    private func updateMine(_ change: (inout [FieldReport]) -> Void) {
        refreshGeneration += 1
        change(&myReports)
        Task { await refresh() }
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
        async let boardFetch = fetch { try await $0.board(incidentId: incidentId, token: $1) }
        let (sitResult, mineResult, pageResult, tasksResult) = await (sit, mine, page, openTasks)
        let boardResult = await boardFetch

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
        if case .failure(LiveAPIError.notFound) = sitResult { activeCheckWanted = true }
        take(sitResult) { applySituation($0) }
        // An older server has no board; its failure never marks the connection as down.
        switch boardResult {
        case .success(let response): board = response
        case .failure(let error): if case LiveAPIError.notFound = error { board = BoardResponse() }
        }
        recomputeBoard()
        if navigating { showStall(stall.due(now: Date(), stallS: board.limits.stallS)) }
        take(mineResult) { myReports = $0.sorted { $0.observedAt > $1.observedAt } }
        take(pageResult) { page in
            reportsCursor = page.nextCursor
            var byId = Dictionary(allReports.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
            for report in page.reports { byId[report.id] = report }
            allReports = byId.values.sorted { $0.observedAt > $1.observedAt }
        }
        take(tasksResult) { tasks = $0.filter { $0.status == .open || $0.status == .accepted }.sorted { $0.createdAt < $1.createdAt } }
        refreshTaskRoutes()
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
                await self?.followActiveIncidentIfDue()
                try? await Task.sleep(for: Self.pollInterval)
            }
        }
    }

    /// Re-reads `GET /api/live/active` after a situation 404 and every minute. A failed read
    /// changes nothing; a different incident id switches this phone to it.
    private func followActiveIncidentIfDue() async {
        guard activeCheckWanted || Date().timeIntervalSince(lastActiveCheck) >= Self.activeInterval else { return }
        activeCheckWanted = false
        lastActiveCheck = Date()
        guard let active = try? await LiveAPIClient.configured().activeIncident(), !Task.isCancelled,
              active.incidentId != incidentId else { return }
        ServerSettings.setFollowedIncident(active.incidentId)
        // Device tokens are server-scoped and stay; a responder token is for the old incident only.
        CredentialStore.delete(.responder)
        credential = CredentialStore.load(.device)
        outbox.discard(notFor: active.incidentId)
        withdrawnChoices = [:]
        answeredStillThere = []
        useIncident(active.incidentId, dropCredentials: false)
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

    /// Joins the server in a link (ADR 0034): checks `GET /api/live/active` on it first, so a bad
    /// address changes nothing; then stores it, follows its incident, and joins as a responder
    /// when the link carries a code. Credentials belong to one server, so a new server drops them.
    func connect(_ link: JoinLink) async throws {
        let active = try await LiveAPIClient(baseURL: link.server).activeIncident()
        let serverChanged = (try? AppConfiguration.apiBaseURL()) != link.server
        ServerSettings.setOverride(link.server, incidentId: active.incidentId)
        useIncident(active.incidentId, dropCredentials: serverChanged)
        var notice = "Joined \(active.name) on \(ServerSettings.currentDescription)."
        if let code = link.code {
            do {
                try await joinAsResponder(inviteCode: code)
                notice += " Signed in as a responder."
            } catch {
                notice += " The invite code was not accepted; you can still follow the drill."
            }
        } else if active.join.inviteRequired {
            notice += " Responders need an invite code."
        }
        joinNotice = notice
    }

    /// Opens a scanned or pasted join link and reports the outcome in `joinNotice`.
    func joinFromText(_ text: String) async {
        do {
            try await connect(JoinLink.parse(text))
        } catch let error as JoinLink.LinkError {
            joinNotice = error.localizedDescription
        } catch {
            joinNotice = "Could not reach that server. Check the address and that this phone is on the same network."
        }
    }

    func joinFromURL(_ url: URL) async { await joinFromText(url.absoluteString) }

    /// Back to the build's `API_BASE_URL` and the default incident.
    func resetServer() {
        ServerSettings.clearOverride()
        useIncident(LiveIncident.defaultId, dropCredentials: true)
        joinNotice = nil
    }

    private func useIncident(_ id: String, dropCredentials: Bool) {
        refreshGeneration += 1
        if dropCredentials {
            CredentialStore.delete(.device)
            CredentialStore.delete(.responder)
            credential = nil
            registration = nil
        }
        incidentId = id
        destinationChoices = Self.loadChoices(incidentId: id)
        situation = nil
        zonesCache = nil
        myZone = nil
        publicItems = []
        myReports = []
        lastCheckIn = nil
        guidanceChange = nil
        guidanceHistory = []
        seenGuidance = false
        lastSeenGuidance = nil
        resetResponderData()
        if let cached = SituationCache.load(incidentId: id) { applySituation(cached, save: false) }
        connection = .idle
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
        if let coord, let last = boardComputedAt, BoardGeo.distance(last, coord) > 50 { recomputeBoard() }
        if coord != nil, boardComputedAt == nil { recomputeBoard() }
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

    /// Public hazards within 500 m of the device that this phone has not answered and did not
    /// report itself, nearest first; computed on the phone from the situation, so nothing is sent
    /// to ask. The one source for the Reports badge and list.
    var stillThereItems: [PublicMapItem] {
        guard let here = lastCoord, let hazards = situation?.hazards else { return [] }
        let origin = CLLocation(latitude: here.lat, longitude: here.lon)
        return hazards
            .filter { !answeredStillThere.contains($0.id) && $0.coord.isValid && !reportedByMe($0) }
            .map { ($0, origin.distance(from: CLLocation(latitude: $0.coord.lat, longitude: $0.coord.lon))) }
            .filter { $0.1 <= 500 }
            .sorted { $0.1 < $1.1 }
            .map(\.0)
    }

    /// Whether this phone's own report (sent or waiting) is behind `item`: same kind, sent during
    /// the item's life (from 15 min before it was first reported), on the same road segment or
    /// within 60 m. Public items carry no report ids, so the match is by kind, place and time.
    private func reportedByMe(_ item: PublicMapItem) -> Bool {
        let since = item.firstReportedAt.addingTimeInterval(-15 * 60)
        let place = CLLocation(latitude: item.coord.lat, longitude: item.coord.lon)
        func matches(kind: ReportKind, coord: LonLat, segment: String?, at: Date) -> Bool {
            guard kind == item.kind, at >= since else { return false }
            if let segment, segment == item.roadRef?.segmentId { return true }
            return coord.isValid && place.distance(from: CLLocation(latitude: coord.lat, longitude: coord.lon)) <= 60
        }
        return myReports.contains {
            matches(kind: $0.kind, coord: $0.location.coord, segment: $0.roadRef?.segmentId, at: $0.observedAt)
        } || pending.contains { draft in
            draft.location.map { matches(kind: draft.kind, coord: $0.coord, segment: nil, at: draft.observedAt) } ?? false
        }
    }

    /// Answers a "still there?" item: yes re-reports its kind; no reports the opposite road kind
    /// when there is one, else only sets the item aside on this phone.
    func answerStillThere(_ item: PublicMapItem, stillThere: Bool) {
        answeredStillThere.insert(item.id)
        let kind = stillThere ? item.kind : item.kind.goneKind
        guard let kind else { return }
        submit(ReportDraft(
            incidentId: incidentId,
            kind: kind,
            severity: kind.hasSeverity ? item.severity : nil,
            location: ReportLocation(coord: item.coord, accuracyM: nil),
            observedAt: Date()))
    }

    // MARK: D1 destination choice

    /// The guidance published for `zoneId`, without any choice applied.
    func publishedGuidance(for zoneId: String) -> ZoneGuidance? {
        situation?.guidance.first { $0.zoneId == zoneId }
    }

    /// The destination this phone chose for `zoneId` while it is offered and unexpired; nil means
    /// the recommended destination.
    func chosenDestinationId(for zoneId: String) -> String? {
        guard let choice = destinationChoices[zoneId] else { return nil }
        if let expires = choice.expiresAt, expires < Date() { return nil }
        return choice.destinationId
    }

    /// True while the guidance version that withdrew this zone's pick is current: show "Your pick
    /// is no longer offered. Showing the recommended route."
    func choiceWithdrawn(for zoneId: String) -> Bool {
        guard let version = withdrawnChoices[zoneId] else { return false }
        return publishedGuidance(for: zoneId)?.version == version
    }

    /// Chooses where to go for `zoneId` (one of `ZoneGuidance.exitOptions`). The phone switches
    /// at once (the recommended destination clears the choice), then posts `me/destination` so
    /// the controller sees the preference. A 400 (no longer offered) restores the previous choice
    /// and rethrows; other failures keep the choice on the phone and rethrow.
    func chooseDestination(zoneId: String, destinationId: String) async throws {
        let options = publishedGuidance(for: zoneId)?.exitOptions ?? []
        let isRecommended = options.first(where: \.recommended)?.id == destinationId
        let previous = destinationChoices[zoneId]
        withdrawnChoices[zoneId] = nil
        setChoice(isRecommended ? nil : StoredDestinationChoice(destinationId: destinationId, expiresAt: nil), zoneId: zoneId)
        do {
            let request = DestinationChoiceRequest(zoneId: zoneId, destinationId: destinationId)
            let stored = try await authorized { try await $0.chooseDestination(request, token: $1) }
            if !isRecommended, destinationChoices[zoneId]?.destinationId == destinationId {
                setChoice(StoredDestinationChoice(destinationId: destinationId, expiresAt: stored.expiresAt), zoneId: zoneId)
            }
        } catch LiveAPIError.rejected(let detail) {
            if destinationChoices[zoneId]?.destinationId == (isRecommended ? nil : destinationId) {
                setChoice(previous, zoneId: zoneId)
            }
            throw LiveAPIError.rejected(detail)
        }
    }

    private func setChoice(_ choice: StoredDestinationChoice?, zoneId: String) {
        destinationChoices[zoneId] = choice
        if let data = try? JSONEncoder().encode(destinationChoices) {
            UserDefaults.standard.set(data, forKey: Self.choicesKey(incidentId))
        }
    }

    private static func choicesKey(_ incidentId: String) -> String { "live.destinationChoices.\(incidentId)" }

    private static func loadChoices(incidentId: String) -> [String: StoredDestinationChoice] {
        guard let data = UserDefaults.standard.data(forKey: choicesKey(incidentId)),
              let choices = try? JSONDecoder().decode([String: StoredDestinationChoice].self, from: data) else { return [:] }
        return choices
    }

    /// Drops picks that expired or that the current guidance no longer offers; a withdrawn pick
    /// is remembered with the version that withdrew it.
    private func reconcileChoices() {
        guard let guidance = situation?.guidance else { return }
        for (zoneId, choice) in destinationChoices {
            if let expires = choice.expiresAt, expires < Date() {
                setChoice(nil, zoneId: zoneId)
                continue
            }
            guard let g = guidance.first(where: { $0.zoneId == zoneId }), g.level != .none else {
                setChoice(nil, zoneId: zoneId)
                continue
            }
            if !g.exitOptions.contains(where: { $0.id == choice.destinationId && !$0.recommended }) {
                setChoice(nil, zoneId: zoneId)
                withdrawnChoices[zoneId] = g.version
            }
        }
    }

    /// Clears `guidanceChange` once it has been announced.
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

    /// Sends one voice turn (`POST incidents/{id}/voice`): recorded or typed words in, a transcript,
    /// a reply and at most one proposed action out. Nothing is stored server-side, and the action
    /// is only a proposal until the person confirms it.
    func voiceTurn(_ request: VoiceTurnRequest) async throws -> VoiceTurnResponse {
        let incidentId = incidentId
        return try await authorized {
            try await $0.voiceTurn(incidentId: incidentId, request: request, token: $1)
        }
    }

    /// A short-lived Cartesia token for the phone's own speech WebSockets (`POST voice/token`).
    /// Throws `VoiceTurnError` with `status` 503 when the server has no Cartesia/Anthropic key.
    func voiceToken() async throws -> VoiceToken {
        let incidentId = incidentId
        return try await authorized {
            try await $0.voiceToken(incidentId: incidentId, token: $1)
        }
    }

    /// A streamed voice turn (`stream: true`, typed or transcribed `text`): reply pieces as the
    /// model writes them, then the final turn. HTTP errors throw before the stream starts.
    func voiceTurnStream(_ request: VoiceTurnRequest) async throws -> AsyncThrowingStream<VoiceStreamEvent, Error> {
        let incidentId = incidentId
        return try await authorized {
            try await $0.voiceTurnStream(incidentId: incidentId, request: request, token: $1)
        }
    }

    /// Accepts a check task (`POST tasks/{id}` with `accepted`); the task stays in `tasks` with
    /// status `accepted`. Throws on 409 when another responder took it.
    func acceptTask(_ task: CheckTask) async throws {
        let accepted = try await authorized { try await $0.acceptTask(id: task.id, token: $1) }
        if let i = tasks.firstIndex(where: { $0.id == task.id }) { tasks[i] = accepted } else { tasks.append(accepted) }
        refreshTaskRoutes()
    }

    /// Fetches the route of each accepted task whose last fetch is older than `routeInterval`,
    /// and drops routes of tasks no longer accepted. A failed fetch keeps the last route.
    private func refreshTaskRoutes() {
        let accepted = role == .civilian ? [] : tasks.filter { $0.status == .accepted }
        let ids = Set(accepted.map(\.id))
        if taskRoutes.keys.contains(where: { !ids.contains($0) }) { taskRoutes = taskRoutes.filter { ids.contains($0.key) } }
        routeFetchedAt = routeFetchedAt.filter { ids.contains($0.key) }
        let now = Date()
        for task in accepted where !routesInFlight.contains(task.id) {
            if let last = routeFetchedAt[task.id], now.timeIntervalSince(last) < Self.routeInterval { continue }
            routeFetchedAt[task.id] = now
            routesInFlight.insert(task.id)
            let id = task.id
            Task {
                defer { routesInFlight.remove(id) }
                guard let response = try? await authorized({ try await $0.taskRoute(id: id, token: $1) }) else { return }
                if tasks.contains(where: { $0.id == id && $0.status == .accepted }), taskRoutes[id] != response {
                    taskRoutes[id] = response
                }
            }
        }
    }

    /// Closes an accepted assist task: the responder reached the resident who asked for help.
    func completeTask(_ task: CheckTask) async throws {
        try await authorized { try await $0.updateTask(id: task.id, status: .done, note: nil, token: $1) }
        tasks.removeAll { $0.id == task.id }
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
        reconcileChoices()
        publicItems = sit.hazards
        if let mine = sit.myCheckin { lastCheckIn = mine }
        if role == .responder { tasks = sit.tasks.filter { $0.status == .open || $0.status == .accepted } }
        let zone = lastCoord.flatMap { c in sit.zones.flatMap { ZoneLocator.zone(containing: c, in: $0) } }
        setZone(zone, force: true)
    }

    /// Sets `myZone` and raises `guidanceChange` when the guidance for it changed after the first load.
    private func setZone(_ zone: LiveZone?, force: Bool = false) {
        if zone != myZone { myZone = zone } else if !force { return }
        // Changes are what the controller published; the person's own pick is not a change.
        let current = publishedGuidance
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
        if let before, before.zoneId == current.zoneId {
            guidanceHistory.insert(GuidanceHistoryEntry(previous: before), at: 0)
        } else {
            guidanceHistory = []
        }
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
        taskRoutes = [:]
        routeFetchedAt = [:]
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

/// Why a change to one of this phone's own reports did not happen, worded for the person.
enum ReportChangeError: LocalizedError {
    /// The unsent draft is being sent right now, or was just sent.
    case sending
    /// The server has no such report for this phone (404).
    case gone

    var errorDescription: String? {
        switch self {
        case .sending: return "This report is being sent right now. Try again in a moment."
        case .gone: return "This report is no longer on the server."
        }
    }
}

/// A destination this phone chose for a zone (D1). `expiresAt` comes from the server once the
/// choice was accepted; nil until then.
struct StoredDestinationChoice: Codable, Equatable {
    var destinationId: String
    var expiresAt: Date?
}

extension ZoneGuidance {
    /// Where the person may go, recommended first: `alternatives` as served. Empty when the
    /// server offers no choice (nil, empty, or a single option).
    var exitOptions: [GuidanceAlternative] {
        var options = alternatives ?? []
        if !options.contains(where: \.recommended), let destination, let route, let safety = route.safety {
            options.insert(GuidanceAlternative(destination: destination, route: route, safety: safety,
                                               load: nil, recommended: true), at: 0)
        }
        options.sort { $0.recommended && !$1.recommended }
        return options.count > 1 ? options : []
    }

    /// The same guidance with the destination and route of the offered alternative
    /// `destinationId`; unchanged when it is nil, the recommended one, or not offered.
    func choosing(_ destinationId: String?) -> ZoneGuidance {
        guard let destinationId, destinationId != destination?.id,
              let option = exitOptions.first(where: { $0.id == destinationId && !$0.recommended }) else { return self }
        var copy = self
        copy.destination = option.destination
        var route = option.route
        if route.safety == nil { route.safety = option.safety }
        copy.route = route
        copy.noRoute = false
        return copy
    }

    /// The recommended option's destination id (the controller's pick).
    var recommendedDestinationId: String? {
        exitOptions.first(where: \.recommended)?.id ?? destination?.id
    }
}


// MARK: - Task board (ADR 0041)

extension LiveStore {
    private static let boardAnsweredKey = "live.boardAnswered"

    /// Answered task ids with their expiry; entries drop once expired.
    fileprivate static func loadBoardAnswered() -> [String: Date] {
        let raw = UserDefaults.standard.dictionary(forKey: boardAnsweredKey) as? [String: TimeInterval] ?? [:]
        let now = Date()
        return raw.mapValues { Date(timeIntervalSince1970: $0) }.filter { $0.value > now }
    }

    fileprivate func markBoardAnswered(_ item: BoardItem) {
        let now = Date()
        boardAnswered[item.taskId] = item.expiresAt
        boardAnswered = boardAnswered.filter { $0.value > now }
        UserDefaults.standard.set(boardAnswered.mapValues { $0.timeIntervalSince1970 }, forKey: Self.boardAnsweredKey)
    }

    /// Picks this phone's questions from the public board on the device. The position is only
    /// compared locally; nothing is sent.
    fileprivate func recomputeBoard() {
        boardComputedAt = lastCoord
        guard role == .civilian else {
            selectedBoardItems = []
            return rebuildBoardQuestions()
        }
        let now = Date()
        boardAnswered = boardAnswered.filter { $0.value > now }
        selectedBoardItems = BoardSelector.select(
            items: board.items.filter { boardAnswered[$0.taskId] == nil },
            route: myGuidance?.route?.line, device: lastCoord, fire: situation?.fire.geometry,
            limits: board.limits, now: now)
        rebuildBoardQuestions()
    }

    fileprivate func rebuildBoardQuestions() {
        let now = Date()
        stallQuestions = stallQuestions.filter { $0.value.expiresAt > now && boardAnswered[$0.key] == nil }
        let stalled = stallQuestions.values.sorted { $0.rank < $1.rank }.map { BoardQuestion(item: $0, isStall: true) }
        let regular = selectedBoardItems.filter { stallQuestions[$0.taskId] == nil }.map { BoardQuestion(item: $0) }
        boardQuestions = stalled + regular
        updateTracking()
    }

    /// The segments to watch while navigating: the selected road questions.
    fileprivate func updateTracking() {
        guard navigating, role == .civilian else {
            passive.reset()
            stall.reset()
            return
        }
        let segments = selectedBoardItems.compactMap(BoardTracked.init(item:))
        stall.track(segments)
        passive.slowRatio = board.limits.slowRatio
        if shareRoadObservations { passive.track(segments) } else { passive.reset() }
    }

    fileprivate func navigationChanged() {
        if !navigating { stallQuestions = [:] }
        passive.reset()
        stall.reset()
        rebuildBoardQuestions()
    }

    /// Feeds a location fix to the on-device detectors while navigating. Passive traversal runs
    /// only with "Share road observations" on; the stall question needs no setting. The fix itself
    /// is never stored or sent.
    func observeFix(_ fix: CLLocation) {
        guard navigating, role == .civilian, fix.horizontalAccuracy >= 0, fix.horizontalAccuracy <= 50 else { return }
        let sample = BoardFix(
            coord: LonLat(lon: fix.coordinate.longitude, lat: fix.coordinate.latitude),
            at: fix.timestamp, speedMps: fix.speed >= 0 ? fix.speed : nil)
        if shareRoadObservations {
            for event in passive.feed(sample) { sendPassive(event) }
        }
        showStall(stall.feed(sample, stallS: board.limits.stallS))
    }

    private func sendPassive(_ event: PassiveTraversal.Traversed) {
        guard let item = selectedBoardItems.first(where: { $0.taskId == event.taskId }) else { return }
        markBoardAnswered(item)
        submit(.passive(incidentId: incidentId, kind: .roadPassable, segmentId: event.segmentId,
                        taskId: event.taskId, observedAt: event.exitedAt, slow: event.slow))
        if event.slow {
            submit(.passive(incidentId: incidentId, kind: .heavyTraffic, segmentId: event.segmentId,
                            taskId: event.taskId, observedAt: event.exitedAt, slow: true))
        }
        recomputeBoard()
    }

    fileprivate func showStall(_ taskIds: [String]) {
        guard !taskIds.isEmpty else { return }
        for id in taskIds {
            if let item = selectedBoardItems.first(where: { $0.taskId == id }), boardAnswered[id] == nil {
                stallQuestions[id] = item
            }
        }
        rebuildBoardQuestions()
    }

    /// An explicit answer: one per task per device. "Has space" and "No" send nothing.
    func answerBoard(_ question: BoardQuestion, _ answer: BoardAnswer) {
        markBoardAnswered(question.item)
        stallQuestions[question.id] = nil
        if let draft = question.draft(for: answer, incidentId: incidentId) { submit(draft) }
        recomputeBoard()
    }
}
