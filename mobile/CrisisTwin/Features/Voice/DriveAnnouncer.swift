import Foundation

/// The sentences Drive mode reads aloud. Built only from guidance the controller (or the route
/// planner) published: the verdict, the road, the minutes and the destination are copied from it,
/// never written by a model. No LLM is involved, so the same guidance always sounds the same.
enum DriveAnnouncer {
    /// On entering Drive mode: "Drive mode. This is a drill. Leave now via Skyway, 26 minutes to
    /// Exit south. Approved by incident command." The drill line is said once, here.
    static func entry(_ g: ZoneGuidance?, zone: String?, isDrill: Bool = true) -> String {
        var parts = ["Drive mode."]
        if isDrill { parts.append("This is a drill.") }
        if let g {
            parts.append(instruction(g, zone: zone))
            if let caveat = g.caveat.flatMap(clean) { parts.append(sentence(caveat)) }
            if g.level != .none { parts.append(sentence(g.sourceText)) }
        } else {
            parts.append("I have no guidance for your area yet.")
        }
        return parts.joined(separator: " ")
    }

    /// When the published guidance for this phone's zone changes: "Route changed. <reason>. Leave
    /// now via Skyway, 26 minutes to Exit south." An escalation leads with the order; an order
    /// lifted says so and nothing more.
    static func change(_ change: GuidanceChange, guidance: ZoneGuidance?) -> String {
        guard let g = guidance else { return sentence("Update. \(change.message)") }
        var parts: [String] = []
        let reason = change.detail.flatMap(clean).map(sentence)
        switch change.level {
        case .none:
            parts.append("Update. The order for your area has been lifted.")
            if let reason { parts.append(reason) }
            return parts.joined(separator: " ")
        case .evacuateNow where change.isEscalation:
            parts.append("Update. You should leave now.")
        case _ where change.isReroute:
            parts.append("Route changed.")
        default:
            parts.append("Update.")
        }
        if let reason { parts.append(reason) }
        parts.append(instruction(g, zone: nil))
        if let caveat = g.caveat.flatMap(clean) { parts.append(sentence(caveat)) }
        return parts.joined(separator: " ")
    }

    /// When the service becomes unreachable: "Signal lost. Your last instruction was: Leave now via
    /// Skyway, 26 minutes to Exit south."
    static func offline(_ g: ZoneGuidance?) -> String {
        guard let g, g.level != .none else {
            return "Signal lost. I have no earlier instruction for your area."
        }
        return "Signal lost. Your last instruction was: \(instruction(g, zone: nil))"
    }

    // MARK: Wording

    /// One instruction from the published guidance. "Leave now via Skyway, 26 minutes to Exit
    /// south." / "Leave now, no open route." / "Be ready to leave. Pack and keep your phone
    /// charged..." / "No order for Paradise Zone 4."
    static func instruction(_ g: ZoneGuidance, zone: String?) -> String {
        switch g.level {
        case .none:
            return sentence(g.level.verdict(zone: zone))
        case .evacuateNow:
            return sentence(leaveClause(g, verdict: g.level.verdict(zone: nil)))
        case .beReady:
            let verdict = g.level.verdict(zone: nil)
            if g.hasRoute {
                return sentence(verdict) + " " + sentence(leaveClause(g, verdict: "Your way out is"))
                    + " " + sentence(g.level.meaning)
            }
            return sentence(verdict) + " " + sentence(g.level.meaning)
        }
    }

    /// "<lead> via Skyway, 26 minutes to Exit south", or "<lead>, no open route" when the zone
    /// has to move and nothing is open.
    private static func leaveClause(_ g: ZoneGuidance, verdict lead: String) -> String {
        guard g.hasRoute, let route = g.route else {
            return g.level == .evacuateNow ? "\(lead), no open route" : lead
        }
        var text = lead
        if let road = route.via.first.flatMap(clean) { text += " via \(road)" }
        let minutes = minutesPhrase(route.etaMin)
        if let name = g.destination?.shortName.trimmingCharacters(in: .whitespaces), !name.isEmpty {
            return text + ", \(minutes) to \(name)"
        }
        return text + ", \(minutes)"
    }

    private static func minutesPhrase(_ minutes: Int) -> String {
        switch minutes {
        case ..<1: return "under a minute"
        case 1: return "1 minute"
        default: return "\(minutes) minutes"
        }
    }

    // MARK: Punctuation

    private static func clean(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// The text with exactly one closing full stop (a question or exclamation mark is kept).
    private static func sentence(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let last = trimmed.last else { return "" }
        return ".?!".contains(last) ? trimmed : trimmed + "."
    }
}
