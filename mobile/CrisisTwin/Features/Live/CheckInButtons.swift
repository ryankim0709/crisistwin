import SwiftUI

/// "I'm out" and "Need help", the two check-ins: a glass pair on Home, filled capsules inside the
/// Map drawer (glass never sits on glass). I'm out morphs into "You're marked out"; Need help
/// asks before sending the location.
struct CheckInButtons: View {
    /// Inside the glass drawer: system fills instead of glass.
    var inDrawer = false

    @Environment(LiveStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    @Namespace private var glass
    @State private var sending: CheckInStatus?
    @State private var confirmingHelp = false
    @State private var errorMessage: String?
    @State private var successTick = 0
    @State private var errorTick = 0

    private var markedOut: Bool { store.lastCheckIn?.status == .out }
    private var helpRequested: Bool { store.lastCheckIn?.status == .needHelp }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            GlassEffectContainer(spacing: 4) {
                // Side by side; stacked at accessibility text sizes so neither label truncates.
                let layout = typeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(spacing: 12)) : AnyLayout(HStackLayout(spacing: 12))
                layout {
                    if markedOut {
                        HStack(spacing: 8) {
                            Image(systemName: "checkmark.circle")
                                .transition(.symbolEffect(.drawOn))
                            Text("You're marked out")
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                        }
                        .font(.headline)
                        .frame(maxWidth: .infinity, minHeight: 56)
                        .checkInSurface(inDrawer: inDrawer, interactive: false, id: "out", in: glass)
                        .accessibilityElement(children: .combine)
                    } else {
                        button(.out, title: "I'm out", systemImage: "checkmark.circle") { checkIn(.out) }
                    }
                    button(.needHelp, title: helpRequested ? "Help requested" : "Need help", systemImage: "sos") {
                        confirmingHelp = true
                    }
                }
            }
            if let errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .animation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.85), value: markedOut)
        .sensoryFeedback(.success, trigger: successTick)
        .sensoryFeedback(.error, trigger: errorTick)
        .confirmationDialog("Send your location to responders?", isPresented: $confirmingHelp, titleVisibility: .visible) {
            Button("Send location") { checkIn(.needHelp) }
            Button("Cancel", role: .cancel) {}
        }
    }

    private func button(_ status: CheckInStatus, title: String, systemImage: String,
                        action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if sending == status {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: systemImage)
                        .foregroundStyle(.primary)
                }
                Text(title)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 56)
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .checkInSurface(inDrawer: inDrawer, interactive: true, id: status.rawValue, in: glass)
        .disabled(sending != nil)
    }

    private func checkIn(_ status: CheckInStatus) {
        sending = status
        errorMessage = nil
        Task {
            do {
                try await store.checkIn(status)
                successTick += 1
                AccessibilityNotification.Announcement(status == .out ? "You're marked out" : "Help requested").post()
            } catch {
                errorMessage = error.localizedDescription
                errorTick += 1
            }
            sending = nil
        }
    }
}

private extension View {
    /// Glass with a morph ID on Home; a quiet system fill inside the drawer.
    @ViewBuilder func checkInSurface(inDrawer: Bool, interactive: Bool, id: String, in namespace: Namespace.ID) -> some View {
        if inDrawer {
            background(.fill.tertiary, in: .capsule)
        } else {
            glassEffect(interactive ? .regular.interactive() : .regular, in: .capsule)
                .glassEffectID(id, in: namespace)
        }
    }
}

/// One "still there?" question about a public hazard near the device, with Yes and No.
struct StillThereRow: View {
    let item: PublicMapItem

    @Environment(LiveStore.self) private var store
    @State private var tick = 0

    var body: some View {
        // Side by side when the words fit on one line; at large text sizes the answers move below.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) {
                question.fixedSize()
                Spacer(minLength: 8)
                answers
            }
            VStack(alignment: .leading, spacing: 10) {
                question
                answers.padding(.leading, 40)
            }
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.capsule)
        .controlSize(.large)
        .sensoryFeedback(.selection, trigger: tick)
        .accessibilityElement(children: .contain)
    }

    private var question: some View {
        HStack(spacing: 12) {
            Image(systemName: item.kind.systemImage)
                .foregroundStyle(item.kind.symbolColor)
                .frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(Self.title(item))
                    .fixedSize(horizontal: false, vertical: true)
                Text(item.lastObservedAt, format: .relative(presentation: .named))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var answers: some View {
        HStack(spacing: 10) {
            Button("Yes") { answer(true) }
                .accessibilityLabel("Yes, still there")
            Button("No") { answer(false) }
                .accessibilityLabel("No, gone")
        }
    }

    /// "Skyway blocked", "Heavy smoke, Pentz Road".
    static func title(_ item: PublicMapItem) -> String {
        let road = item.roadRef?.name
        switch item.kind {
        case .roadBlocked: return road.map { "\($0) blocked" } ?? "Road blocked"
        case .roadPassable: return road.map { "\($0) passable" } ?? "Road passable"
        default: return [item.kind.title, road].compactMap { $0 }.joined(separator: ", ")
        }
    }

    private func answer(_ stillThere: Bool) {
        tick += 1
        withAnimation(.snappy) { store.answerStillThere(item, stillThere: stillThere) }
    }
}
