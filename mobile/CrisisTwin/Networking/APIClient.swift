import Foundation

struct HealthResponse: Decodable {
    let status: String
    let service: String
    let version: String
}

enum APIError: LocalizedError {
    case configuration
    case unexpectedResponse
    case unavailable
    case httpStatus(Int)

    var errorDescription: String? {
        switch self {
        case .configuration:
            return "Set a valid API_BASE_URL in the Xcode configuration. Release requires HTTPS."
        case .unexpectedResponse:
            return "The API returned an unexpected health response."
        case .unavailable:
            return "The API is reachable, but its database is unavailable."
        case .httpStatus(let code):
            return "The API returned HTTP \(code)."
        }
    }
}

struct APIClient {
    let baseURL: URL

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        configuration.timeoutIntervalForResource = 10
        configuration.urlCache = nil
        return URLSession(configuration: configuration)
    }()

    func fetchHealth() async throws -> HealthResponse {
        let url = baseURL.appendingPathComponent("api").appendingPathComponent("health")
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await Self.session.data(for: request)
        try Task.checkCancellation()
        guard let response = response as? HTTPURLResponse else {
            throw APIError.unexpectedResponse
        }
        guard response.statusCode == 200 || response.statusCode == 503 else {
            throw APIError.httpStatus(response.statusCode)
        }
        guard let health = try? JSONDecoder().decode(HealthResponse.self, from: data),
              health.service == "crisistwin-api",
              !health.version.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw APIError.unexpectedResponse
        }
        if response.statusCode == 503 && health.status == "unavailable" {
            throw APIError.unavailable
        }
        guard response.statusCode == 200, health.status == "ok" else {
            throw APIError.unexpectedResponse
        }
        return health
    }
}
