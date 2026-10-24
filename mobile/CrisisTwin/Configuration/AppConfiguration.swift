import Foundation

enum AppConfiguration {
    /// An origin, without an API path. Debug supports local HTTP development only. A server
    /// chosen at run time by a join link (`ServerSettings`) replaces the build's default.
    static func apiBaseURL(bundle: Bundle = .main) throws -> URL {
        if let override = ServerSettings.overrideURL { return override }
        return try origin(forInfoKey: "APIBaseURL", bundle: bundle)
    }

    /// The web workspace origin; the app appends `/fire`. Same rules as the API origin.
    static func webBaseURL(bundle: Bundle = .main) throws -> URL {
        try origin(forInfoKey: "WebBaseURL", bundle: bundle)
    }

    private static func origin(forInfoKey key: String, bundle: Bundle) throws -> URL {
        guard let rawValue = bundle.object(forInfoDictionaryKey: key) as? String else {
            throw APIError.configuration
        }
        return try validatedOrigin(rawValue)
    }

    /// The origin rules shared by the build default and run-time join links.
    static func validatedOrigin(_ rawValue: String) throws -> URL {
        guard let components = URLComponents(string: rawValue),
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
