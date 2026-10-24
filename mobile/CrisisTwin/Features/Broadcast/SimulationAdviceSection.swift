import SwiftUI

/// "Your home" on the Web simulation screen: what the latest Simulation Studio run says about the
/// home set in Plan (leave now, leave later, already left and so on). Polls every 10 seconds while
/// the screen is visible and always carries the simulated-planning-exercise notice. It is never
/// an evacuation order.
struct SimulationAdviceSection: View {
    let editHome: () -> Void

    @Environment(MeetingPlanStore.self) private var plan

    private enum Phase: Equatable {
        case loading
        case noSimulation
        case noHome
        case error(String)
        case advice(SimAdvice)
    }

    @State private var phase: Phase = .loading

    static let fallbackNotice =
        "Simulated evacuation (planning exercise). Homes and addresses are synthetic. This is not an evacuation order."

    var body: some View {
        Section {
            if plan.plan.home == nil {
                setHome
            } else {
                stateView
            }
        } header: {
            Text("Your home · simulated")
        } footer: {
            Text(notice)
        }
        .task(id: plan.plan.home) { await poll() }
    }

    private var notice: String {
        if case .advice(let advice) = phase { return advice.notice }
        return Self.fallbackNotice
    }

    // MARK: States

    private var setHome: some View {
        Button(action: editHome) {
            Label("Set your home to see what the simulation says for it", systemImage: "house")
        }
        .accessibilityHint("Opens the home editor")
    }

    @ViewBuilder private var stateView: some View {
        switch phase {
        case .loading:
            HStack(spacing: 12) {
                ProgressView()
                Text("Checking the simulation")
                    .foregroundStyle(Color.ctInkMuted)
            }
        case .noSimulation:
            message("No simulation published", "pause.circle",
                    detail: "Simulation Studio has not published a run yet.")
        case .noHome:
            message("No synthetic home near your address", "house.slash",
                    detail: "The simulation only has made-up homes along its dispatch area's streets.")
        case .error(let text):
            message("Can't reach the simulation", "wifi.slash", detail: text)
        case .advice(let advice):
            adviceView(advice)
        }
    }

    private func message(_ title: String, _ symbol: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(title, systemImage: symbol)
                .font(.headline)
                .foregroundStyle(Color.ctInk)
            Text(detail)
                .font(.subheadline)
                .foregroundStyle(Color.ctInkMuted)
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private func adviceView(_ advice: SimAdvice) -> some View {
        let look = Self.look(for: advice)
        return VStack(alignment: .leading, spacing: 10) {
            Label(look.headline, systemImage: look.symbol)
                .font(.ctTitle)
                .foregroundStyle(look.tint)
                .fixedSize(horizontal: false, vertical: true)
            Text("\(advice.home.address) · \(advice.home.zoneName) (synthetic home)")
                .font(.subheadline)
                .foregroundStyle(Color.ctInk)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                if let minute = advice.minute {
                    Text("Simulation \(Self.clock(minute))")
                }
                if let updated = advice.updatedDate {
                    Text("· updated \(updated, style: .time)")
                }
            }
            .font(.footnote)
            .monospacedDigit()
            .foregroundStyle(Color.ctInkMuted)
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: Wording

    /// `T+h:mm` from elapsed simulation minutes.
    static func clock(_ minute: Int) -> String {
        let m = max(minute, 0)
        return "T+\(m / 60):" + String(format: "%02d", m % 60)
    }

    static func look(for advice: SimAdvice) -> (headline: String, symbol: String, tint: Color) {
        switch advice.advice {
        case .leaveNow:
            return ("Leave now", "figure.walk.departure", .ctDanger)
        case .leaveLater:
            guard let order = advice.orderMinute else {
                return ("Leave later", "clock", .ctWarning)
            }
            var text = "Leave at \(clock(order))"
            if let until = advice.minutesUntilOrder { text += " (in \(until) min)" }
            return (text, "clock", .ctWarning)
        case .left:
            return ("Already left", "checkmark.circle", .ctSuccess)
        case .noOrder:
            return ("No evacuation order in this simulation", "minus.circle", .ctInk)
        case .cutOff:
            return ("No road out in this simulation", "exclamationmark.triangle", .ctDanger)
        case .cleared:
            return ("Zone cleared", "checkmark.circle", .ctSuccess)
        case .overrun:
            return ("Fire reached the zone", "flame", .ctDanger)
        case .unknown:
            return ("Waiting for the simulation to start", "hourglass", .ctInkMuted)
        }
    }

    // MARK: Polling

    /// Refreshes every ~10 s until the task is cancelled (the view disappears or the home changes).
    private func poll() async {
        guard let home = plan.plan.home else { return }
        phase = .loading
        while !Task.isCancelled {
            await refresh(home)
            try? await Task.sleep(for: .seconds(10))
        }
    }

    private func refresh(_ home: MeetingPoint) async {
        do {
            let client = try SimStateClient.configured()
            let advice = try await client.advice(lon: home.longitude, lat: home.latitude)
            guard !Task.isCancelled else { return }
            phase = .advice(advice)
        } catch is CancellationError {
            return
        } catch let error as SimStateError {
            phase = error == .noSimulation ? .noSimulation : .noHome
        } catch {
            guard !Task.isCancelled else { return }
            phase = .error(error.localizedDescription)
        }
    }
}
