import SwiftUI

// The one sentence the phone says, and the two places it says it in round 2: the Slab at the
// top of Home and the bottom accessory under every tab (design spec, "Point of view").

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
}

/// The Slab: a solid block in the status color with the verdict in SF Pro Expanded Black, the
/// way out, the source and age, and Start. Only for Leave now and Be ready.
struct Slab: View {
    let guidance: ZoneGuidance
    let passesFire: Bool
    /// The last update while offline; nil when online.
    let offlineSince: Date?
    /// The incident clock at a wall time, for the age.
    let incidentNow: (Date) -> Date
    var openDestination: () -> Void
    var start: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let level = guidance.level
        VStack(alignment: .leading, spacing: 14) {
            Label {
                Text(level.verdict(zone: nil))
            } icon: {
                Image(systemName: level.symbol)
                    .contentTransition(.symbolEffect(.replace))
            }
            .font(.ctVerdict)
            // Two lines at ordinary sizes; a third only when shrinking is not enough (D2: the
            // verdict never truncates).
            .lineLimit(3)
            .minimumScaleFactor(0.7)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)

            if guidance.hasRoute {
                VStack(alignment: .leading, spacing: 6) {
                    if let via = guidance.viaText {
                        Text(via)
                            .font(.title3.weight(.semibold))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if passesFire {
                        Label("Every way out passes the fire", systemImage: "flame.fill")
                            .font(.subheadline.weight(.semibold))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                destinationRow
            } else {
                Text("No open route. Shelter in place and tap Need help.")
                    .font(.title3.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
            }

            meta

            if guidance.hasRoute {
                Button(action: start) {
                    Text("Start")
                        .font(.headline)
                        .foregroundStyle(level.fill ?? .primary)
                        .frame(maxWidth: .infinity, minHeight: 50)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .tint(level.onFill)
                .accessibilityHint("Opens the map and follows you along the route")
            }
        }
        .foregroundStyle(level.onFill)
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(level.fill ?? .clear, in: .rect(cornerRadius: 28, style: .continuous))
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.35), value: level)
    }

    private var destinationRow: some View {
        Button(action: openDestination) {
            HStack(spacing: 10) {
                Text(guidance.destination?.shortName ?? "Destination")
                    .font(.body.weight(.semibold))
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                if let eta = guidance.etaText {
                    Text(eta)
                        .font(.body.weight(.semibold))
                        .monospacedDigit()
                        .contentTransition(.numericText())
                        .fixedSize()
                }
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.bold))
                    .accessibilityHidden(true)
            }
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(guidance.spokenSentence)
        .accessibilityHint("Shows the route on the map")
    }

    /// Source and age; the age gives way first when space runs out (D2).
    @ViewBuilder private var meta: some View {
        if let offlineSince {
            Label("Offline. Guidance from \(offlineSince.formatted(date: .omitted, time: .shortened)).",
                  systemImage: "wifi.slash")
                .font(.footnote)
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
                    Text(guidance.sourceText)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .font(.footnote)
                .opacity(0.86)
            }
        }
    }
}

/// The bottom accessory: the level glyph and verdict, and the ETA trailing. The same in the
/// inline and expanded placements. The verdict never truncates: the offline glyph goes first,
/// then the ETA, then the verdict shrinks (D2).
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
                verdict.minimumScaleFactor(0.6)
            }
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(guidance.spokenSentence)
        .accessibilityHint("Opens the map")
        .accessibilityIdentifier("guidance-accessory")
    }

    private var verdict: some View {
        Label {
            Text(guidance.level.verdict(zone: nil))
                .font(.ctVerdictCompact)
                .lineLimit(1)
        } icon: {
            Image(systemName: guidance.level.symbol)
                .foregroundStyle(guidance.level.glyph)
                .contentTransition(.symbolEffect(.replace))
        }
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
