import Foundation

/// A screen the voice agent can open. `route` starts directions.
enum VoiceScreen: String, Codable {
    case home, map, route, reports, plan
}

/// The one thing a voice turn proposes (`docs/live-reports.md`, voice endpoint), or the pending
/// proposal the phone sends back. Wire shape: `{"type": "report" | "check_in" | "open" |
/// "confirm" | "cancel", ...}`. An unknown `type` or value fails to decode.
enum VoiceAction: Codable, Equatable {
    case report(kind: ReportKind, severity: ReportSeverity?, note: String?)
    case checkIn(CheckInStatus)
    case open(VoiceScreen)
    case confirm
    case cancel

    private enum CodingKeys: String, CodingKey {
        case type, kind, severity, note, status, screen
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "report":
            self = .report(
                kind: try container.decode(ReportKind.self, forKey: .kind),
                // A severity the app doesn't know is dropped; the report itself is still useful.
                severity: try? container.decodeIfPresent(ReportSeverity.self, forKey: .severity),
                note: try? container.decodeIfPresent(String.self, forKey: .note))
        case "check_in":
            self = .checkIn(try container.decode(CheckInStatus.self, forKey: .status))
        case "open":
            self = .open(try container.decode(VoiceScreen.self, forKey: .screen))
        case "confirm":
            self = .confirm
        case "cancel":
            self = .cancel
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: container, debugDescription: "Unknown voice action type")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .report(let kind, let severity, let note):
            try container.encode("report", forKey: .type)
            try container.encode(kind, forKey: .kind)
            try container.encodeIfPresent(severity, forKey: .severity)
            try container.encodeIfPresent(note, forKey: .note)
        case .checkIn(let status):
            try container.encode("check_in", forKey: .type)
            try container.encode(status, forKey: .status)
        case .open(let screen):
            try container.encode("open", forKey: .type)
            try container.encode(screen, forKey: .screen)
        case .confirm:
            try container.encode("confirm", forKey: .type)
        case .cancel:
            try container.encode("cancel", forKey: .type)
        }
    }
}

/// The guidance for this phone's zone, as the person sees it, so the agent answers from it
/// and does not invent its own.
struct VoiceGuidanceContext: Codable, Equatable {
    var level: String
    var headline: String
    var spoken: String
    var reason: String?
    var caveat: String?
    var source: String
}

/// One earlier exchange in this voice session.
struct VoiceHistoryTurn: Codable, Equatable {
    var user: String
    var agent: String
}

/// What the server is told about the person's situation. No coordinates.
struct VoiceContext: Codable, Equatable {
    var zone: String?
    /// `civilian` or `responder`.
    var role: String
    var guidance: VoiceGuidanceContext?
    /// The action awaiting a yes/no, so `confirm` and `cancel` have something to answer.
    var pending: VoiceAction?
    /// The last few turns, oldest first.
    var history: [VoiceHistoryTurn]
}

/// Body of `POST incidents/{id}/voice`: exactly one of `audioB64` (base64 WAV) or `text`.
struct VoiceTurnRequest: Encodable {
    var audioB64: String?
    var text: String?
    var context: VoiceContext
    /// Ask the server for a spoken reply (`audioB64` in the response).
    var speak: Bool
}

/// Reply to a voice turn. `evidenceClass` is `ai_interpretation`: the reply and action are a
/// model's reading of what was said, not an observation.
struct VoiceTurnResponse: Decodable {
    var transcript: String
    var reply: String
    /// Nil when the turn proposes nothing, or when the server sent an action this app can't read.
    var action: VoiceAction?
    var audioB64: String?
    var audioFormat: String?
    /// `cartesia`, `failed` or `skipped`.
    var tts: String
    var model: String?
    var evidenceClass: String

    private enum CodingKeys: String, CodingKey {
        case transcript, reply, action, audioB64, audioFormat, tts, model, evidenceClass
    }
}

extension VoiceTurnResponse {
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        transcript = try container.decode(String.self, forKey: .transcript)
        reply = try container.decode(String.self, forKey: .reply)
        // `try?` over the optional decode: an unknown or malformed action becomes nil instead of
        // failing the whole turn, so the reply is still shown and spoken.
        action = try? container.decodeIfPresent(VoiceAction.self, forKey: .action)
        audioB64 = try container.decodeIfPresent(String.self, forKey: .audioB64)
        audioFormat = try container.decodeIfPresent(String.self, forKey: .audioFormat)
        tts = try container.decodeIfPresent(String.self, forKey: .tts) ?? "skipped"
        model = try container.decodeIfPresent(String.self, forKey: .model)
        evidenceClass = try container.decodeIfPresent(String.self, forKey: .evidenceClass) ?? "ai_interpretation"
    }
}

/// Non-2xx from the voice endpoint, worded for the person (server `detail` when present).
struct VoiceTurnError: LocalizedError {
    var message: String
    var errorDescription: String? { message }
}
