import Foundation

enum AppConfiguration {
    /// An origin, without an API path. Debug supports local HTTP development only.
    static func apiBaseURL(bundle: Bundle = .main) throws -> URL {
        try origin(forInfoKey: "APIBaseURL", bundle: bundle)
    }

    /// The web workspace origin; the app appends `/maps`. Same rules as the API origin.
    static func webBaseURL(bundle: Bundle = .main) throws -> URL {
        try origin(forInfoKey: "WebBaseURL", bundle: bundle)
    }

    private static func origin(forInfoKey key: String, bundle: Bundle) throws -> URL {
        guard let rawValue = bundle.object(forInfoDictionaryKey: key) as? String,
              let components = URLComponents(string: rawValue),
              let scheme = components.scheme,
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/",
              components.port.map({ (1...65535).contains($0) }) ?? true,
              let url = components.url else {
            throw APIError.configuration
        }

        #if DEBUG
        let localHost = host == "localhost" || host.hasSuffix(".local")
        guard scheme == "https" || (scheme == "http" && localHost) else {
            throw APIError.configuration
        }
        #else
        guard scheme == "https" else {
            throw APIError.configuration
        }
        #endif

        return url
    }
}
