import SwiftUI

/// The Map tab's guidance drawer, collapsed: the way out ("Via Fairview Drive"), the destination
/// and its ETA, and the two check-ins. The verdict is not here: the accessory directly below
/// carries it. A glass surface; there is no grabber until the drawer has an expanded state (D3).
struct GuidanceSheet: View {
    let guidance: ZoneGuidance

    @Environment(LiveStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if guidance.hasRoute {
                VStack(alignment: .leading, spacing: 6) {
                    if let via = guidance.viaText {
                        Text(via)
                            .font(.title3.weight(.semibold))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if store.passesFire(guidance) {
                        Label("Every way out passes the fire", systemImage: "flame.fill")
                            .font(.subheadline.weight(.semibold))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                HStack(spacing: 10) {
                    Text(guidance.destination?.shortName ?? "Destination")
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    if let eta = guidance.etaText {
                        Text(eta)
                            .font(.body.weight(.semibold))
                            .monospacedDigit()
                            .contentTransition(.numericText())
                            .fixedSize()
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(guidance.spokenSentence)
            } else {
                Text("No open route. Shelter in place and tap Need help.")
                    .font(.title3.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
            }
            CheckInButtons(inDrawer: true)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular, in: .rect(cornerRadius: 34))
    }
}

/// Responder task helpers shared by the sheet and the map.
extension LiveStore {
    private var openTasks: [CheckTask] {
        (situation?.tasks ?? tasks).filter { $0.status == .open || $0.status == .accepted }
    }

    /// The task to show: accepted first, then assigned to this device, then oldest. Nil for civilians.
    var currentTask: CheckTask? {
        guard role != .civilian else { return nil }
        let me = credential?.partyKey
        return openTasks.min { a, b in
            func rank(_ t: CheckTask) -> Int {
                if t.status == .accepted { return 0 }
                return t.assignee != nil && t.assignee == me ? 1 : 2
            }
            return rank(a) == rank(b) ? a.createdAt < b.createdAt : rank(a) < rank(b)
        }
    }

    var otherTaskCount: Int { max(0, openTasks.count - 1) }

    /// Where the task points: its coordinate, else a known hazard or report on its segment.
    func taskTarget(_ task: CheckTask) -> LonLat? {
        if let c = task.target.coord, c.isValid { return c }
        guard let id = task.target.segmentId else { return nil }
        return situation?.hazards.first { $0.roadRef?.segmentId == id }?.coord
            ?? allReports.first { $0.roadRef?.segmentId == id }?.location.coord
    }

    /// The road name for the task's segment, else "the marked place".
    func targetName(_ task: CheckTask) -> String {
        if let id = task.target.segmentId {
            let name = situation?.hazards.first { $0.roadRef?.segmentId == id }?.roadRef?.name
                ?? allReports.first { $0.roadRef?.segmentId == id }?.roadRef?.name
                ?? publicItems.first { $0.roadRef?.segmentId == id }?.roadRef?.name
            if let name { return name }
        }
        return "the marked place"
    }
}
