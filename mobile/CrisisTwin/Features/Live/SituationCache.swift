import Foundation

/// The last situation the service returned, kept in Application Support so a relaunch without
/// signal still shows the last instruction, route and destination (with the offline band).
/// Holds zones, all guidance, the fire estimate and hazards; nothing the device does not
/// already show.
enum SituationCache {
    private static func url(_ incidentId: String) -> URL? {
        guard let base = try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        else { return nil }
        let safe = incidentId.replacingOccurrences(of: "/", with: "_")
        return base.appendingPathComponent("situation-\(safe).json")
    }

    /// The cached situation for the incident, or nil when none was saved or it no longer decodes.
    static func load(incidentId: String) -> Situation? {
        guard let url = url(incidentId), let data = try? Data(contentsOf: url),
              let situation = try? LiveJSON.decoder.decode(Situation.self, from: data),
              situation.incidentId == incidentId
        else { return nil }
        return situation
    }

    /// Serial, so an older poll's write never lands after a newer one.
    private static let queue = DispatchQueue(label: "crisistwin.live.situation-cache", qos: .utility)

    /// Writes the situation atomically, off the main thread. Zones must already be filled in.
    static func save(_ situation: Situation) {
        guard situation.zones != nil, let url = url(situation.incidentId) else { return }
        queue.async {
            let encoder = JSONEncoder()
            encoder.keyEncodingStrategy = .convertToSnakeCase
            encoder.dateEncodingStrategy = .iso8601
            guard let data = try? encoder.encode(situation) else { return }
            try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
    }
}
