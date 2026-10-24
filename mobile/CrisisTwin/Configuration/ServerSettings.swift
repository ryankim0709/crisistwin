import SwiftUI
import VisionKit

/// The server this phone talks to at run time (ADR 0034). The build's `API_BASE_URL` stays the
/// default; a join link or QR code can point the same build at a Wi-Fi host, an HTTPS tunnel or
/// a cloud host. The override is stored in UserDefaults and validated by `AppConfiguration` on
/// every read, so a bad stored value is ignored rather than trusted.
enum ServerSettings {
    private static let originKey = "server.override.origin"
    private static let incidentKey = "server.override.incidentId"
    /// The incident the server's active endpoint last named, used when there is no override.
    private static let followedKey = "server.followed.incidentId"

    /// The incident this phone last followed from `GET /api/live/active`; nil before the first switch.
    static var followedIncidentId: String? { UserDefaults.standard.string(forKey: followedKey) }

    /// Remembers the incident the server made active. With a joined server the override's own
    /// incident id is updated instead, so the override semantics stay as they were.
    static func setFollowedIncident(_ id: String) {
        UserDefaults.standard.set(id, forKey: overrideURL == nil ? followedKey : incidentKey)
    }

    /// The validated override origin, or nil when the build default is in use.
    static var overrideURL: URL? {
        guard let raw = UserDefaults.standard.string(forKey: originKey) else { return nil }
        return try? AppConfiguration.validatedOrigin(raw)
    }

    /// The incident `GET /api/live/active` named when the override was set.
    static var overrideIncidentId: String? {
        overrideURL == nil ? nil : UserDefaults.standard.string(forKey: incidentKey)
    }

    static func setOverride(_ origin: URL, incidentId: String) {
        UserDefaults.standard.set(origin.absoluteString, forKey: originKey)
        UserDefaults.standard.set(incidentId, forKey: incidentKey)
    }

    static func clearOverride() {
        UserDefaults.standard.removeObject(forKey: originKey)
        UserDefaults.standard.removeObject(forKey: incidentKey)
        UserDefaults.standard.removeObject(forKey: followedKey)
    }

    /// `host[:port]` of the server in use, for display.
    static var currentDescription: String {
        guard let url = try? AppConfiguration.apiBaseURL() else { return "Not configured" }
        let host = url.host ?? url.absoluteString
        return url.port.map { "\(host):\($0)" } ?? host
    }
}

/// `crisistwin://join?server=<origin>&code=<invite>`. `code` is optional.
struct JoinLink: Equatable {
    let server: URL
    let code: String?

    enum LinkError: LocalizedError {
        case notAJoinLink
        case badServer

        var errorDescription: String? {
            switch self {
            case .notAJoinLink: return "That is not a CrisisTwin join link."
            case .badServer:
                return "The server address in that link is not allowed. Use https://, or http:// for a .local name."
            }
        }
    }

    static func parse(_ url: URL) throws -> JoinLink {
        guard url.scheme?.lowercased() == "crisistwin", url.host?.lowercased() == "join",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let rawServer = items.first(where: { $0.name == "server" })?.value else {
            throw LinkError.notAJoinLink
        }
        guard let server = try? AppConfiguration.validatedOrigin(rawServer) else { throw LinkError.badServer }
        let code = items.first(where: { $0.name == "code" })?.value?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return JoinLink(server: server, code: code?.isEmpty == false ? code : nil)
    }

    static func parse(_ text: String) throws -> JoinLink {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            throw LinkError.notAJoinLink
        }
        return try parse(url)
    }
}

/// `GET /api/live/active`: the one incident this server runs (ADR 0030). Unauthenticated.
struct ActiveIncident: Decodable, Equatable {
    struct Join: Decodable, Equatable { let inviteRequired: Bool }
    let incidentId: String
    let name: String
    let mode: String
    let label: String
    let join: Join
}

/// The About screen's server card: what the app is talking to, scan a join QR code, reset.
@MainActor
struct ServerSettingsCard: View {
    @Environment(LiveStore.self) private var store
    let onChange: () -> Void
    @State private var scanning = false
    @State private var overridden = ServerSettings.overrideURL != nil

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            PlanCardHeader("Server")
            LabeledContent(overridden ? "Joined" : "Default") {
                Text(ServerSettings.currentDescription)
                    .monospaced()
                    .textSelection(.enabled)
            }
            .font(.subheadline)
            .foregroundStyle(Color.ctInk)
            if let notice = store.joinNotice {
                Text(notice)
                    .font(.subheadline)
                    .foregroundStyle(Color.ctInkMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if JoinScanner.isSupported {
                Button { scanning = true } label: { Label("Scan join QR code", systemImage: "qrcode.viewfinder") }
                    .buttonStyle(PlanPillStyle(kind: .secondary, fullWidth: true))
            }
            if overridden {
                Button("Reset to default") {
                    store.resetServer()
                    overridden = false
                    onChange()
                }
                .buttonStyle(PlanPillStyle(kind: .secondary, fullWidth: true))
            }
        }
        .ctPanel()
        .fullScreenCover(isPresented: $scanning) {
            JoinScannerSheet { text in
                scanning = false
                Task {
                    await store.joinFromText(text)
                    overridden = ServerSettings.overrideURL != nil
                    onChange()
                }
            }
        }
        .onChange(of: store.joinNotice) { overridden = ServerSettings.overrideURL != nil }
    }
}

private struct JoinScannerSheet: View {
    let onScan: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            JoinScanner(onScan: onScan)
                .ignoresSafeArea()
                .navigationTitle("Scan join code")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}

/// VisionKit's QR scanner. Camera access is requested by the system on first use.
private struct JoinScanner: UIViewControllerRepresentable {
    let onScan: (String) -> Void

    static var isSupported: Bool { DataScannerViewController.isSupported }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced,
            recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false, isGuidanceEnabled: true)
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        guard !scanner.isScanning else { return }
        try? scanner.startScanning()
    }

    func makeCoordinator() -> Coordinator { Coordinator(onScan: onScan) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onScan: (String) -> Void
        private var done = false
        init(onScan: @escaping (String) -> Void) { self.onScan = onScan }

        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem],
                         allItems: [RecognizedItem]) {
            for case .barcode(let code) in items {
                guard !done, let text = code.payloadStringValue, (try? JoinLink.parse(text)) != nil else { continue }
                done = true
                scanner.stopScanning()
                onScan(text)
            }
        }
    }
}
