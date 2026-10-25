import SwiftUI

// The one sentence the phone says, and the places it says it: the Slab at the top of Home and
// the bottom accessory under every tab. Both open the guidance detail (design-v2, item 6).

extension ZoneGuidance {
    /// The guidance has a way out to show (a route, not `no_route`).
    var hasRoute: Bool { !noRoute && route != nil }

    /// "Via Fairview Drive".
    var viaText: String? { route?.via.first.map { "Via \($0)" } }

    /// "2 min"; a zone already at its exit has a zero-length route.
    var etaText: String? {
        guard let minutes = route?.etaMin else { return nil }
        return minutes < 1 ? "<1 min" : "\(minutes) min"
    }

    /// Who stands behind it: "Approved by incident command", "Official order", "Model estimate".
    var sourceText: String {
        if reasonCode?.contains("official") == true { return "Official order" }
        return approvedBy == .controller ? "Approved by incident command" : "Model estimate"
    }

    /// "Leave now, 12 minutes to Exit south".
    var spokenSentence: String {
        var parts = [level.verdict(zone: nil)]
        if hasRoute, let minutes = route?.etaMin, let name = destination?.shortName {
            parts.append(minutes < 1 ? "under a minute to \(name)" : "\(minutes) minutes to \(name)")
        } else if level == .evacuateNow {
            parts.append("no open route")
        }
        return parts.joined(separator: ", ")
    }

    /// The published reason, trimmed; nil when empty.
    var reasonText: String? {
        let text = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }
}

extension GuidanceLevel {
    /// What the level asks of the person, in one sentence.
    var meaning: String {
        switch self {
        case .evacuateNow: return "Go now by the route below. Don't stop to pack."
        case .beReady: return "Pack and keep your phone charged. Leave early if you feel unsafe."
        case .none: return "Nothing to do for your area right now."
        }
    }
}

/// One earlier version of this zone's guidance, for Home's Changes.
struct GuidanceHistoryEntry: Equatable, Identifiable {
    var version: Int
    var title: String
    var reason: String
    var asOf: Date

    var id: Int { version }

    init(previous g: ZoneGuidance) {
        version = g.version
        title = Self.title(g)
        reason = g.reason.trimmingCharacters(in: .whitespacesAndNewlines)
        asOf = g.asOf
    }

    /// "Leave now via Pentz Road", "Be ready to leave", "No order".
    static func title(_ g: ZoneGuidance) -> String {
        let verdict = g.level.verdict(zone: nil)
        guard g.level != .none else { return verdict }
        if g.noRoute { return "\(verdict), no open route" }
        return g.route?.via.first.map { "\(verdict) via \($0)" } ?? verdict
    }
}

extension RelativeAge {
    /// "12 min", "2 h", "1 h 5 min"; "just now" under a minute. For labels that already say what aged.
    static func short(from date: Date, to now: Date) -> String {
        let minutes = Int(max(0, now.timeIntervalSince(date)) / 60)
        if minutes < 1 { return "just now" }
        if minutes < 60 { return "\(minutes) min" }
        let hours = minutes / 60, rest = minutes % 60
        return rest == 0 ? "\(hours) h" : "\(hours) h \(rest) min"
    }
}

extension LiveStore {
    /// Guidance that asks something of the device's zone (Leave now or Be ready); nil otherwise.
    var activeGuidance: ZoneGuidance? {
        guard let guidance = myGuidance, guidance.level != .none else { return nil }
        return guidance
    }

    /// The last successful update while the service is unreachable; nil when online.
    var offlineSince: Date? {
        guard case .unavailable = connection else { return nil }
        return situation?.generatedAt
    }

    var isExercise: Bool { situation?.incident?.isExercise == true }

    /// The incident's name. The Exercise tag already says it is an exercise, so a trailing
    /// "exercise" in the name is not repeated.
    var incidentTitle: String? {
        guard var name = situation?.incident?.name?.trimmingCharacters(in: .whitespaces), !name.isEmpty else { return nil }
        if isExercise, name.lowercased().hasSuffix(" exercise") { name = String(name.dropLast(" exercise".count)) }
        return name
    }

    /// The route runs through the current fire estimate: the planner only does that when every
    /// way out passes the fire (its least-exposure fallback). Checked on the device.
    func passesFire(_ guidance: ZoneGuidance) -> Bool {
        guard let geometry = situation?.fire.geometry, let line = guidance.route?.line else { return false }
        return line.contains { $0.isValid && ZoneLocator.contains(geometry, $0) }
    }

    /// The headline caveat under the way out: the server's ("Every route out passes through the
    /// fire"), read live. Only a server that predates route safety gets the device's own check.
    func caveatText(for guidance: ZoneGuidance) -> String? {
        if let text = guidance.caveat?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty { return text }
        guard guidance.route?.safety == nil else { return nil }
        return passesFire(guidance) ? "Every way out passes the fire" : nil
    }
}

/// Source and age as one quiet line: "Approved by incident command" and "Updated 9 min ago".
/// The age moves below when space runs out (D2); offline replaces both.
struct GuidanceProvenance: View {
    let guidance: ZoneGuidance
    let offlineSince: Date?
    let incidentNow: (Date) -> Date

    var body: some View {
        if let offlineSince {
            Label("Offline. Guidance from \(offlineSince.formatted(date: .omitted, time: .shortened)).",
                  systemImage: "wifi.slash")
                .fixedSize(horizontal: false, vertical: true)
        } else {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                let age = "Updated \(RelativeAge.text(from: guidance.asOf, to: incidentNow(context.date)))"
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) {
                        Text(guidance.sourceText)
                        Spacer(minLength: 8)
                        Text(age).monospacedDigit()
                    }
                    .lineLimit(1)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(guidance.sourceText)
                        Text(age).monospacedDigit()
                    }
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

/// The Slab: a solid block in the status color carrying the verdict, why, and who stands behind
/// it. Only for Leave now and Be ready. The whole block opens the guidance detail.
struct Slab: View {
    let guidance: ZoneGuidance
    /// The last update while offline; nil when online.
    let offlineSince: Date?
    /// The incident clock at a wall time, for the age.
    let incidentNow: (Date) -> Date
    var open: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let level = guidance.level
        Button(action: open) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: level.symbol)
                        .contentTransition(.symbolEffect(.replace))
                        .accessibilityHidden(true)
                    Text(level.verdict(zone: nil))
                        // Two lines at ordinary sizes; a third only when shrinking is not enough
                        // (D2: the verdict never truncates).
                        .lineLimit(3)
                        .minimumScaleFactor(0.7)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .font(.body.weight(.bold))
                        .opacity(0.6)
                        .accessibilityHidden(true)
                }
                .font(.ctVerdict)

                if let reason = guidance.reasonText {
                    Text(reason)
                        .font(.body.weight(.medium))
                        .fixedSize(horizontal: false, vertical: true)
                }

                GuidanceProvenance(guidance: guidance, offlineSince: offlineSince, incidentNow: incidentNow)
                    .font(.footnote)
                    .opacity(0.8)
                    .padding(.top, 2)
            }
            .foregroundStyle(level.onFill)
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(level.fill ?? .clear, in: .rect(cornerRadius: 20, style: .continuous))
            .contentShape(.rect(cornerRadius: 20))
        }
        .buttonStyle(SlabPressStyle())
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.35), value: level)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityHint("Shows what this means and the way out")
        .accessibilityIdentifier("home-slab")
    }
}

/// A slight dip when pressed, so the Slab reads as tappable without a border or shadow.
private struct SlabPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.snappy(duration: 0.2), value: configuration.isPressed)
    }
}

/// The bottom accessory: the level glyph and verdict at standard width, and the ETA trailing.
/// The same in the inline and expanded placements; tapping opens the guidance detail. The
/// verdict never truncates: the offline glyph goes first, then the ETA, then the verdict shrinks.
struct GuidanceAccessory: View {
    let guidance: ZoneGuidance
    let offline: Bool
    var open: () -> Void

    var body: some View {
        Button(action: open) {
            ViewThatFits(in: .horizontal) {
                row(offline: offline, eta: true)
                row(offline: false, eta: true)
                row(offline: false, eta: false)
                verdict.minimumScaleFactor(0.5)
            }
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(guidance.spokenSentence)
        .accessibilityHint("Shows the guidance details")
        .accessibilityIdentifier("guidance-accessory")
    }

    private var verdict: some View {
        HStack(spacing: 8) {
            Image(systemName: guidance.level.symbol)
                .foregroundStyle(guidance.level.glyph)
                .contentTransition(.symbolEffect(.replace))
            Text(guidance.level.verdict(zone: nil))
                .lineLimit(1)
        }
        .font(.subheadline.weight(.semibold))
    }

    private func row(offline: Bool, eta: Bool) -> some View {
        HStack(spacing: 8) {
            verdict.fixedSize()
            Spacer(minLength: 8)
            if offline {
                Image(systemName: "wifi.slash").foregroundStyle(.secondary)
            }
            if eta, let text = guidance.etaText {
                Text(text)
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .fixedSize()
            }
        }
    }
}
