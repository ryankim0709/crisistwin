import CoreLocation
import Foundation
import Observation

/// A place a household agrees to meet if separated. User-chosen, not an official shelter.
struct MeetingPoint: Codable, Equatable {
    var name: String
    var note: String
    /// WGS84 decimal degrees.
    var latitude: Double
    var longitude: Double

    var isValid: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && latitude.isFinite && (-90...90).contains(latitude)
            && longitude.isFinite && (-180...180).contains(longitude)
    }

    var coordinate: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: latitude, longitude: longitude) }

    /// Apple Maps link that opens directions from the viewer's location. Works without the app.
    var directionsURL: URL {
        var components = URLComponents(string: "https://maps.apple.com/")!
        components.queryItems = [
            URLQueryItem(name: "daddr", value: "\(latitude),\(longitude)"),
            URLQueryItem(name: "q", value: name),
        ]
        return components.url!
    }
}

struct TrustedContact: Codable, Equatable, Identifiable {
    /// The system contact identifier, so picking the same person twice does not duplicate them.
    var id: String
    var name: String
    var phone: String?
}

/// Version 1 of the on-device plan. Later phases (simulation check, AI suggestions,
/// trusted circle sync) add fields; bump `version` and migrate on load if a field changes meaning.
struct MeetingPlan: Codable, Equatable {
    var version = 1
    var primary: MeetingPoint?
    var backup: MeetingPoint?
    var contacts: [TrustedContact] = []
    /// Where the household lives, used only on this phone to find its zone in the live
    /// simulation. Never shared with family. Its coordinates are sent to the API only for the
    /// Web simulation screen's "Your home" simulated-advice lookup. Optional, so older files still load.
    var home: MeetingPoint?

    var shareText: String {
        var lines = ["Our CrisisTwin meeting plan. If we get separated, meet here:"]
        for (label, point) in [("Primary", primary), ("Backup", backup)] {
            guard let point else { continue }
            lines.append("")
            lines.append("\(label): \(point.name)")
            if !point.note.isEmpty { lines.append(point.note) }
            lines.append(point.directionsURL.absoluteString)
        }
        lines.append("")
        lines.append("Personal plan, not an official instruction. Follow evacuation orders from local authorities first.")
        return lines.joined(separator: "\n")
    }
}

/// Saves the plan as JSON in Application Support. Nothing leaves the device unless the user shares it.
@MainActor
@Observable
final class MeetingPlanStore {
    private(set) var plan = MeetingPlan()
    private(set) var errorMessage: String?

    private let fileURL: URL

    init(fileURL: URL? = nil) {
        self.fileURL = fileURL ?? URL.applicationSupportDirectory.appendingPathComponent("meeting-plan.json")
        load()
    }

    func update(_ change: (inout MeetingPlan) -> Void) {
        var next = plan
        change(&next)
        guard next != plan else { return }
        do {
            try FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(next).write(to: fileURL, options: [.atomic, .completeFileProtection])
            plan = next
            errorMessage = nil
        } catch {
            errorMessage = "Your plan could not be saved. Try again."
        }
    }

    private func load() {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return }
        do {
            let decoded = try JSONDecoder().decode(MeetingPlan.self, from: Data(contentsOf: fileURL))
            guard decoded.version == 1,
                  decoded.primary?.isValid ?? true,
                  decoded.backup?.isValid ?? true,
                  decoded.home?.isValid ?? true else {
                throw CocoaError(.fileReadCorruptFile)
            }
            plan = decoded
        } catch {
            // Keep the unreadable file instead of overwriting it with an empty plan.
            let aside = fileURL.deletingPathExtension().appendingPathExtension("unreadable.json")
            try? FileManager.default.removeItem(at: aside)
            try? FileManager.default.moveItem(at: fileURL, to: aside)
            errorMessage = "Your saved plan could not be read, so this is a new plan."
        }
    }
}
