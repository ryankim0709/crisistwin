import SwiftUI

/// What a person sees of their report's progress: four plain steps (D6).
enum ReportProgress: Int, Equatable, CaseIterable {
    case received = 1, beingChecked, confirmed, resolved

    /// The one place backend report statuses map onto the four steps. An unverified report with
    /// an open verify task is being checked; dismissed reports are closed, so they read Resolved.
    init(_ status: ReportStatus, hasOpenTask: Bool = false) {
        switch status {
        case .unverified: self = hasOpenTask ? .beingChecked : .received
        case .corroborated: self = .beingChecked
        case .responderConfirmed, .confirmed: self = .confirmed
        case .resolved, .dismissed: self = .resolved
        }
    }

    var word: String {
        switch self {
        case .received: return "Received"
        case .beingChecked: return "Being checked"
        case .confirmed: return "Confirmed"
        case .resolved: return "Resolved"
        }
    }

    var symbol: String {
        switch self {
        case .received: return "tray.and.arrow.down"
        case .beingChecked: return "magnifyingglass"
        case .confirmed: return "checkmark.seal.fill"
        case .resolved: return "checkmark.circle"
        }
    }

    /// The step's tone: brand while it moves, success once confirmed, quiet once closed.
    var tone: Color {
        switch self {
        case .received, .beingChecked: return .ctBrand
        case .confirmed: return .ctSuccess
        case .resolved: return .ctInkMuted
        }
    }
}

extension LiveStore {
    /// The step to show for one of this device's reports.
    func progress(of report: FieldReport) -> ReportProgress {
        let open = (situation?.tasks ?? tasks).contains {
            ($0.status == .open || $0.status == .accepted) && $0.reportIds.contains(report.id)
        }
        return ReportProgress(report.status, hasOpenTask: open)
    }

    /// Where a report is, in words: its snapped road, a known road nearby, or its offset from
    /// the person.
    func placeWords(_ coord: LonLat, road: String?) -> String? {
        if let road, !road.isEmpty { return road }
        return nearestRoad(to: coord) ?? offsetFromHere(coord)
    }
}

/// The four steps as a small meter with the current step's word; nil `progress` is a report
/// still waiting on the phone to send.
struct ReportSteps: View {
    let progress: ReportProgress?

    var body: some View {
        let reached = progress?.rawValue ?? 0
        let tone = progress?.tone ?? Color.ctInkSubtle
        HStack(spacing: 10) {
            HStack(spacing: 3) {
                ForEach(ReportProgress.allCases, id: \.self) { step in
                    Capsule()
                        .fill(step.rawValue <= reached ? tone : Color.ctBorder)
                        .frame(width: 18, height: 5)
                }
            }
            Label(progress?.word ?? "Waiting to send", systemImage: progress?.symbol ?? "clock")
                .labelStyle(StepLabelStyle())
                .font(.subheadline.weight(.medium))
                .foregroundStyle(progress == nil ? Color.ctInkMuted : tone)
                .contentTransition(.symbolEffect(.replace))
        }
        .animation(.snappy, value: reached)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(progress.map { "\($0.word), step \($0.rawValue) of 4" } ?? "Waiting to send")
    }
}

private struct StepLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 5) {
            configuration.icon.imageScale(.small)
            configuration.title
        }
    }
}

/// The web kit's pill buttons: brand-filled for primary, brand-soft for secondary.
struct FieldPill: ButtonStyle {
    var primary = false
    var minHeight: CGFloat = 44

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .lineLimit(1)
            .foregroundStyle(primary ? Color.ctBackground : Color.ctBrandStrong)
            .padding(.horizontal, 16)
            .frame(minHeight: minHeight)
            .background(primary ? Color.ctBrand : Color.ctBrandSoft, in: .capsule)
            .contentShape(.capsule)
            .opacity(configuration.isPressed ? 0.75 : 1)
    }
}

/// A section title on a content screen.
struct FieldSectionTitle: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.ctTitle)
            .foregroundStyle(Color.ctInk)
            .padding(.horizontal, 4)
            .accessibilityAddTraits(.isHeader)
    }
}

/// The Reports tab: Report what I see (New report on top), pending "still there?" questions,
/// and this device's reports with their four-step status.
struct ReportsView: View {
    @Environment(LiveStore.self) private var store
    @Environment(AppRouter.self) private var router
    @Environment(\.reportZoom) private var reportZoom

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    CTPageHeader(title: "Reports") {
                        if store.isExercise { ExerciseTag() }
                    }
                    .padding(.bottom, -8)
                    Button {
                        router.openReport(from: "reports-new")
                    } label: {
                        Label("New report", systemImage: "plus")
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(FieldPill(primary: true, minHeight: 52))
                    .reportZoomSource("reports-new", in: reportZoom)

                    let questions = store.stillThereItems
                    if !questions.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            FieldSectionTitle("Still there?")
                            panelRows(questions) { StillThereCard(item: $0) }
                        }
                        .transition(.opacity)
                    }

                    if !store.pending.isEmpty || !store.myReports.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            FieldSectionTitle("Yours")
                            VStack(spacing: 0) {
                                ForEach(store.pending) { draft in
                                    ReportRow(kind: draft.kind,
                                              place: store.placeWords(draft.location.coord, road: nil),
                                              time: draft.observedAt, progress: nil)
                                    if draft.id != store.pending.last?.id || !store.myReports.isEmpty { rowDivider }
                                }
                                ForEach(store.myReports) { report in
                                    ReportRow(kind: report.kind,
                                              place: store.placeWords(report.location.coord, road: report.roadRef?.name),
                                              time: report.observedAt, progress: store.progress(of: report))
                                    if report.id != store.myReports.last?.id { rowDivider }
                                }
                            }
                            .ctPanel(padding: 0)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .ctScreenBackground()
            .ctOwnHeader()
            .refreshable { await store.refresh() }
            .animation(.snappy, value: store.stillThereItems.map(\.id))
        }
    }

    private var rowDivider: some View {
        Rectangle().fill(Color.ctBorderSubtle).frame(height: 1).padding(.leading, 54)
    }

    private func panelRows<Item: Identifiable, Row: View>(_ items: [Item], @ViewBuilder row: @escaping (Item) -> Row) -> some View {
        VStack(spacing: 0) {
            ForEach(items) { item in
                row(item)
                if item.id != items.last?.id { rowDivider }
            }
        }
        .ctPanel(padding: 0)
    }
}

/// One of this device's reports: what, where, when, and its step.
private struct ReportRow: View {
    let kind: ReportKind
    let place: String?
    let time: Date
    let progress: ReportProgress?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            KindBadge(kind: kind)
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text(kind.title)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Color.ctInk)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    Text(time, format: .dateTime.hour().minute())
                        .font(.footnote)
                        .monospacedDigit()
                        .foregroundStyle(Color.ctInkMuted)
                }
                if let place {
                    Text(place)
                        .font(.subheadline)
                        .foregroundStyle(Color.ctInkMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                ReportSteps(progress: progress)
                    .padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .accessibilityElement(children: .combine)
    }
}

/// The kind's symbol on a soft disc.
struct KindBadge: View {
    let kind: ReportKind

    var body: some View {
        Image(systemName: kind.systemImage)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(kind.symbolColor)
            .frame(width: 30, height: 30)
            .background(Color.ctSurfaceMuted, in: .circle)
            .accessibilityHidden(true)
    }
}

/// A "still there?" question about a public hazard near the person, answered in one tap.
private struct StillThereCard: View {
    let item: PublicMapItem

    @Environment(LiveStore.self) private var store
    @State private var tick = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                KindBadge(kind: item.kind)
                VStack(alignment: .leading, spacing: 2) {
                    Text(StillThereRow.title(item))
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Color.ctInk)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(item.lastObservedAt, format: .relative(presentation: .named))
                        .font(.footnote)
                        .foregroundStyle(Color.ctInkMuted)
                }
            }
            HStack(spacing: 8) {
                Button("Still there") { answer(true) }
                    .buttonStyle(FieldPill(primary: true))
                Button("Gone") { answer(false) }
                    .buttonStyle(FieldPill())
            }
            .padding(.leading, 42)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .sensoryFeedback(.selection, trigger: tick)
        .accessibilityElement(children: .contain)
    }

    private func answer(_ stillThere: Bool) {
        tick += 1
        withAnimation(.snappy) { store.answerStillThere(item, stillThere: stillThere) }
    }
}
