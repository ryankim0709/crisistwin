import Foundation

/// Failures of the live reports API, worded for the person using the app.
enum LiveAPIError: LocalizedError {
    case notConfigured
    case network
    case notFound
    case unauthorized
    case forbidden
    case rateLimited
    /// 409: another responder took the task, or it is closed.
    case conflict
    /// 409 `report_locked`: a responder or controller acted on the report, so it can't change.
    case reportLocked
    case serviceUnavailable
    case server(Int)
    /// 400: the server will not accept this report as written. Retrying the same draft will not help.
    case rejected(String?)
    case invalidResponse

    private static let savedNote = "Reports you make are saved on this phone and sent when it's back."

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "Set a valid API_BASE_URL in the Xcode configuration. Release requires HTTPS."
        case .network:
            return "Live reports service is unreachable. \(Self.savedNote)"
        case .notFound:
            return "Live reports are not available on this server yet. \(Self.savedNote)"
        case .unauthorized:
            return "This phone's live credential was not accepted. Try again in a moment."
        case .forbidden:
            return "This role is not allowed to do that."
        case .rateLimited:
            return "Too many requests right now. Live reports will try again shortly."
        case .conflict:
            return "That task was already taken or closed."
        case .reportLocked:
            return "Locked: a responder or controller has acted on it."
        case .serviceUnavailable:
            return "Live reports service is temporarily unavailable. \(Self.savedNote)"
        case .server(let code):
            return "Live reports service had a problem (HTTP \(code)). \(Self.savedNote)"
        case .rejected(let detail):
            return detail.map { "The server did not accept that: \($0)" } ?? "The server did not accept that."
        case .invalidResponse:
            return "Live reports service sent an unexpected response. \(Self.savedNote)"
        }
    }
}

/// HTTP client for docs/live-reports.md. Stateless: callers pass the bearer token.
struct LiveAPIClient {
    let baseURL: URL

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        configuration.timeoutIntervalForResource = 10
        configuration.urlCache = nil
        return URLSession(configuration: configuration)
    }()

    /// Voice turns upload audio and wait on transcription, a model and speech synthesis.
    private static let voiceSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 45
        configuration.timeoutIntervalForResource = 45
        configuration.urlCache = nil
        return URLSession(configuration: configuration)
    }()

    /// The incident this server runs; no credential needed. `baseURL` may be a not-yet-saved server.
    func activeIncident() async throws -> ActiveIncident {
        try await get(ActiveIncident.self, ["active"])
    }

    static func configured() throws -> LiveAPIClient {
        do {
            return LiveAPIClient(baseURL: try AppConfiguration.apiBaseURL())
        } catch {
            throw LiveAPIError.notConfigured
        }
    }

    private struct Items<T: Decodable>: Decodable { let items: [T] }
    private struct Reports: Decodable { let reports: [FieldReport] }
    private struct Tasks: Decodable { let tasks: [CheckTask] }
    private struct ReportResponse: Decodable { let report: FieldReport }
    private struct JoinBody: Encodable { let inviteCode: String }
    private struct TaskUpdate: Encodable {
        let status: TaskStatus
        let note: String?
    }
    private struct ErrorBody: Decodable {
        let error: String?
        let detail: String?
    }

    func registerDevice() async throws -> LiveCredential {
        try await get(LiveCredential.self, ["devices"], method: "POST")
    }

    func join(incidentId: String, inviteCode: String) async throws -> LiveCredential {
        try await get(LiveCredential.self, ["incidents", incidentId, "join"], method: "POST",
                      body: JoinBody(inviteCode: inviteCode))
    }

    /// Any 2xx counts as accepted, including the existing report for a repeated `client_id`.
    func submit(_ draft: ReportDraft, token: String) async throws {
        _ = try await send(["incidents", draft.incidentId, "reports"], method: "POST", token: token, body: draft)
    }

    func myReports(token: String) async throws -> [FieldReport] {
        try await get(Reports.self, ["me", "reports"], token: token).reports
    }

    /// Changes one of this party's own reports. 409 `report_locked` throws `reportLocked`; a report
    /// that is not this party's, or no longer exists, is 404 (`notFound`).
    func editReport(id: String, patch: ReportPatch, token: String) async throws -> FieldReport {
        try await get(ReportResponse.self, ["me", "reports", id], method: "PATCH", token: token, body: patch).report
    }

    /// Withdraws one of this party's own reports (the server keeps it as `withdrawn`). Idempotent.
    func withdrawReport(id: String, token: String) async throws -> FieldReport {
        try await get(ReportResponse.self, ["me", "reports", id], method: "DELETE", token: token).report
    }

    func publicMap(incidentId: String, token: String) async throws -> [PublicMapItem] {
        try await get(Items<PublicMapItem>.self, ["incidents", incidentId, "public-map"], token: token).items
    }

    func reports(incidentId: String, since: String?, token: String) async throws -> ReportsPage {
        let query = since.map { [URLQueryItem(name: "since", value: $0)] } ?? []
        return try await get(ReportsPage.self, ["incidents", incidentId, "reports"], query: query, token: token)
    }

    func prompts(incidentId: String, near coord: LonLat, token: String) async throws -> [PublicMapItem] {
        let near = String(format: "%.6f,%.6f", coord.lon, coord.lat)
        return try await get(Items<PublicMapItem>.self, ["incidents", incidentId, "prompts"],
                             query: [URLQueryItem(name: "near", value: near)], token: token).items
    }

    /// `zonesVersion` is the cached version; the server omits zones when it matches (`?zones=0`).
    func situation(incidentId: String, includeZones: Bool, token: String) async throws -> Situation {
        let query = includeZones ? [] : [URLQueryItem(name: "zones", value: "0")]
        return try await get(Situation.self, ["incidents", incidentId, "situation"], query: query, token: token)
    }

    /// The public task board (ADR 0041): questions only, the same for everyone. The phone picks
    /// its own on the device, so nothing about the person is sent.
    func board(incidentId: String, token: String) async throws -> BoardResponse {
        try await get(BoardResponse.self, ["incidents", incidentId, "board"], token: token)
    }

    func checkIn(incidentId: String, request: CheckInRequest, token: String) async throws -> CheckIn {
        try await get(CheckInResponse.self, ["incidents", incidentId, "checkins"], method: "POST",
                      token: token, body: request).checkin
    }

    /// One voice turn. 401 throws `unauthorized`; any other non-2xx throws `VoiceTurnError` with the
    /// server's `detail`, since voice failures are worded for the person at the microphone.
    func voiceTurn(incidentId: String, request: VoiceTurnRequest, token: String) async throws -> VoiceTurnResponse {
        let (data, status) = try await perform(
            ["incidents", incidentId, "voice"], method: "POST", token: token, body: request,
            session: Self.voiceSession)
        switch status {
        case 200..<300: break
        case 401: throw LiveAPIError.unauthorized
        default:
            let detail = (try? LiveJSON.decoder.decode(ErrorBody.self, from: data))?.detail
            throw VoiceTurnError(message: detail ?? Self.voiceFallback(status))
        }
        do {
            return try LiveJSON.decoder.decode(VoiceTurnResponse.self, from: data)
        } catch {
            throw LiveAPIError.invalidResponse
        }
    }

    private static func voiceFallback(_ status: Int) -> String {
        switch status {
        case 400: return "I couldn't use that audio. Try again."
        case 429: return "Too many voice requests. Try again in a minute."
        case 503: return "Voice mode isn't set up on this server."
        case 504: return "Voice mode took too long. Try again."
        default: return "Voice mode had a problem (HTTP \(status)). Try again."
        }
    }

    func updateLocation(_ update: ResponderLocationUpdate, token: String) async throws {
        _ = try await send(["me", "location"], method: "POST", token: token, body: update)
    }

    func updateProfile(_ profile: ProfileUpdate, token: String) async throws {
        _ = try await send(["me", "profile"], method: "POST", token: token, body: profile)
    }

    func clearLocation(token: String) async throws {
        _ = try await send(["me", "location"], method: "DELETE", token: token)
    }

    /// D1: the destination this device chose for its zone (`POST me/destination`). No location.
    /// 400 (`rejected`) when the destination is not currently offered for that zone.
    func chooseDestination(_ request: DestinationChoiceRequest, token: String) async throws -> DestinationChoice {
        try await get(DestinationChoice.self, ["me", "destination"], method: "POST", token: token, body: request)
    }

    func acceptTask(id: String, token: String) async throws -> CheckTask {
        try await get(TaskResponse.self, ["tasks", id], method: "POST", token: token,
                      body: TaskUpdate(status: .accepted, note: nil)).task
    }

    func myTasks(token: String) async throws -> [CheckTask] {
        try await get(Tasks.self, ["me", "tasks"], token: token).tasks
    }

    func updateTask(id: String, status: TaskStatus, note: String?, token: String) async throws {
        _ = try await send(["tasks", id], method: "POST", token: token, body: TaskUpdate(status: status, note: note))
    }

    /// The route to an accepted task. A 409 with `reason: "no_origin"` (no shared location) is
    /// returned as a response with no route; any other 409 throws `conflict`.
    func taskRoute(id: String, token: String) async throws -> TaskRouteResponse {
        let (data, status) = try await perform(["tasks", id, "route"], method: "GET", token: token)
        if status == 409, let body = try? LiveJSON.decoder.decode(TaskRouteResponse.self, from: data),
           body.reason == "no_origin" {
            return body
        }
        try Self.check(status, data)
        do {
            return try LiveJSON.decoder.decode(TaskRouteResponse.self, from: data)
        } catch {
            throw LiveAPIError.invalidResponse
        }
    }

    private func get<T: Decodable>(
        _ type: T.Type, _ path: [String], method: String = "GET", query: [URLQueryItem] = [],
        token: String? = nil, body: (any Encodable)? = nil
    ) async throws -> T {
        let data = try await send(path, method: method, query: query, token: token, body: body)
        do {
            return try LiveJSON.decoder.decode(T.self, from: data)
        } catch {
            throw LiveAPIError.invalidResponse
        }
    }

    private func send(
        _ path: [String], method: String, query: [URLQueryItem] = [], token: String? = nil,
        body: (any Encodable)? = nil
    ) async throws -> Data {
        let (data, status) = try await perform(path, method: method, query: query, token: token, body: body)
        try Self.check(status, data)
        return data
    }

    private static func check(_ status: Int, _ data: Data) throws {
        switch status {
        case 200..<300: return
        case 400: throw LiveAPIError.rejected((try? LiveJSON.decoder.decode(ErrorBody.self, from: data))?.detail)
        case 401: throw LiveAPIError.unauthorized
        case 403: throw LiveAPIError.forbidden
        case 409:
            let error = (try? LiveJSON.decoder.decode(ErrorBody.self, from: data))?.error
            throw error == "report_locked" ? LiveAPIError.reportLocked : LiveAPIError.conflict
        case 404: throw LiveAPIError.notFound
        case 429: throw LiveAPIError.rateLimited
        case 503: throw LiveAPIError.serviceUnavailable
        default: throw LiveAPIError.server(status)
        }
    }

    private func perform(
        _ path: [String], method: String, query: [URLQueryItem] = [], token: String? = nil,
        body: (any Encodable)? = nil, session: URLSession = LiveAPIClient.session
    ) async throws -> (Data, Int) {
        var url = baseURL.appendingPathComponent("api").appendingPathComponent("live")
        for part in path { url.appendPathComponent(part) }
        if !query.isEmpty {
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
            components?.queryItems = query
            guard let withQuery = components?.url else { throw LiveAPIError.invalidResponse }
            url = withQuery
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try LiveJSON.encoder.encode(body)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw LiveAPIError.network
        }
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse else { throw LiveAPIError.invalidResponse }
        return (data, http.statusCode)
    }
}
