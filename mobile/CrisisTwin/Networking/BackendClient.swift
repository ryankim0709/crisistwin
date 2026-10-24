import Foundation

/// A failed backend call, with the server's `detail` text when it sent one.
enum BackendError: LocalizedError {
    case http(status: Int, code: String?, detail: String?)
    case unexpectedResponse

    var status: Int? {
        if case .http(let status, _, _) = self { return status }
        return nil
    }

    var errorDescription: String? {
        switch self {
        case .http(_, _, let detail?): return detail
        case .http(let status, _, nil): return "The server returned HTTP \(status)."
        case .unexpectedResponse: return "The server returned an unexpected response."
        }
    }
}

/// JSON calls to the CrisisTwin API (live broadcast, families and mobile data). Same session rules as
/// `APIClient`: ephemeral, no cache, 10-second timeouts, no automatic retry.
struct BackendClient {
    let baseURL: URL

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        configuration.timeoutIntervalForResource = 10
        configuration.urlCache = nil
        return URLSession(configuration: configuration)
    }()

    static func configured() throws -> BackendClient {
        BackendClient(baseURL: try AppConfiguration.apiBaseURL())
    }

    private struct ErrorBody: Decodable {
        let error: String?
        let detail: String?
    }

    /// Sends a request and returns the body of a 2xx response.
    @discardableResult
    func send(
        _ method: String, _ path: String, query: [URLQueryItem] = [], body: (any Encodable)? = nil, token: String? = nil
    ) async throws -> Data {
        var url = baseURL.appending(path: "api/\(path)")
        if !query.isEmpty {
            url.append(queryItems: query)
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            let encoder = JSONEncoder()
            encoder.keyEncodingStrategy = .convertToSnakeCase
            request.httpBody = try encoder.encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await Self.session.data(for: request)
        try Task.checkCancellation()
        guard let response = response as? HTTPURLResponse else { throw BackendError.unexpectedResponse }
        guard (200..<300).contains(response.statusCode) else {
            let parsed = try? JSONDecoder().decode(ErrorBody.self, from: data)
            throw BackendError.http(status: response.statusCode, code: parsed?.error, detail: parsed?.detail)
        }
        return data
    }

    func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        do {
            return try decoder.decode(type, from: data)
        } catch {
            throw BackendError.unexpectedResponse
        }
    }
}

/// Parses the server's ISO 8601 UTC timestamps, with or without fractional seconds.
enum ServerDate {
    static func parse(_ text: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
}
