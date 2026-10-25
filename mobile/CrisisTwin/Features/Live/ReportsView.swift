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
        case .resolved, .dismissed, .withdrawn: self = .resolved
        // A status this build does not know yet: the server has it, nothing more is claimed.
        case .unknown: self = .received
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
        HStack(spacing: 8) {
            HStack(spacing: 4) {
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
        HStack(spacing: 4) {
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

/// Opens one of this phone's reports from Yours. Keyed by `clientId`, so a draft that is sent
/// while it is open becomes the sent report in place.
private struct YourReportRoute: Hashable {
    let clientId: UUID
}

/// The Reports tab: Report what I see (New report on top), pending "still there?" questions,
/// and this device's reports with their four-step status. A report opens to edit or delete.
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
                    let board = store.boardQuestions
                    if !questions.isEmpty || !board.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            FieldSectionTitle("Still there?")
                            VStack(spacing: 0) {
                                ForEach(questions) { item in
                                    StillThereCard(item: item)
                                    if item.id != questions.last?.id || !board.isEmpty { rowDivider }
                                }
                                ForEach(board) { question in
                                    BoardQuestionCard(question: question)
                                    if question.id != board.last?.id { rowDivider }
                                }
                            }
                            .ctPanel(padding: 0)
                        }
                        .transition(.opacity)
                    }

                    if store.pending.contains(where: { $0.location != nil }) || !store.myReports.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            FieldSectionTitle("Yours")
                            VStack(spacing: 0) {
                                ForEach(store.pending.filter { $0.location != nil }) { draft in
                                    NavigationLink(value: YourReportRoute(clientId: draft.clientId)) {
                                        ReportRow(kind: draft.kind,
                                                  place: draft.location.flatMap { store.placeWords($0.coord, road: nil) },
                                                  time: draft.observedAt, progress: nil)
                                    }
                                    .buttonStyle(.plain)
                                    if draft.id != store.pending.last(where: { $0.location != nil })?.id || !store.myReports.isEmpty { rowDivider }
                                }
                                ForEach(store.myReports) { report in
                                    NavigationLink(value: YourReportRoute(clientId: report.clientId)) {
                                        ReportRow(kind: report.kind,
                                                  place: store.placeWords(report.location.coord, road: report.roadRef?.name),
                                                  time: report.observedAt, progress: store.progress(of: report),
                                                  edited: report.editedAt != nil)
                                    }
                                    .buttonStyle(.plain)
                                    if report.id != store.myReports.last?.id { rowDivider }
                                }
                            }
                            .ctPanel(padding: 0)
                        }
                    }
                }
                .ctScreenPadding()
            }
            .ctScreenBackground()
            .ctOwnHeader()
            .refreshable { await store.refresh() }
            .animation(.snappy, value: store.stillThereItems.map(\.id) + store.boardQuestions.map(\.id))
            .navigationDestination(for: YourReportRoute.self) { route in
                ReportDetailView(clientId: route.clientId)
            }
        }
    }

    private var rowDivider: some View {
        Rectangle().fill(Color.ctBorderSubtle).frame(height: 1).padding(.leading, 58)
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

/// One of this device's reports: what, where, when, its step, and whether it was edited.
private struct ReportRow: View {
    let kind: ReportKind
    let place: String?
    let time: Date
    let progress: ReportProgress?
    var edited = false

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
                    if edited { EditedTag() }
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
            Image(systemName: "chevron.forward")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Color.ctInkSubtle)
                .frame(maxHeight: .infinity)
                .accessibilityHidden(true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the report")
    }
}

/// "Edited" in words on a quiet chip, so the tag never relies on colour.
private struct EditedTag: View {
    var body: some View {
        Text("Edited")
            .font(.caption.weight(.semibold))
            .foregroundStyle(Color.ctInkMuted)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Color.ctSurfaceMuted, in: .capsule)
    }
}

/// One of this phone's reports, opened from Yours: what was sent, where, when and its step.
/// While nobody with authority has acted on it (or it is still on the phone) it can be edited in
/// the report sheet or deleted; otherwise it is read-only with the reason.
private struct ReportDetailView: View {
    let clientId: UUID

    @Environment(LiveStore.self) private var store
    @Environment(LocationProvider.self) private var location
    @Environment(\.dismiss) private var dismiss

    /// The last version seen, kept while a sent draft is between the outbox and the list.
    @State private var last: ReportEditTarget?
    @State private var editing: ReportEditTarget?
    @State private var confirmingDelete = false
    @State private var deleting = false
    @State private var message: String?
    @State private var tick = 0

    private static let lockedLine = LiveAPIError.reportLocked.localizedDescription

    /// The sent report first, so a draft that was just accepted shows its server state.
    private var current: ReportEditTarget? {
        if let report = store.myReports.first(where: { $0.clientId == clientId }) { return .report(report) }
        if let draft = store.pending.first(where: { $0.clientId == clientId }) { return .draft(draft) }
        return nil
    }

    var body: some View {
        let shown = current ?? last
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let shown {
                    summary(shown)
                    if let note = shown.note, !note.isEmpty { notePanel(note) }
                    actions(shown)
                } else {
                    Text("This report is no longer in your list.")
                        .font(.body)
                        .foregroundStyle(Color.ctInkMuted)
                        .ctPanel()
                }
            }
            .ctScreenPadding()
        }
        .ctScreenBackground()
        .navigationTitle(shown?.kind.title ?? "Report")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.refresh() }
        .onChange(of: current, initial: true) { _, new in
            if let new { last = new }
        }
        .sensoryFeedback(.selection, trigger: tick)
        .sheet(item: $editing) { target in
            NavigationStack { ReportSheet(editing: target) }
                .presentationDetents([.large])
                .environment(store)
                .environment(location)
        }
        .confirmationDialog("Delete this report?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete report", role: .destructive) { delete() }
        } message: {
            if shown?.report == nil {
                Text("It has not been sent yet. It will be removed from this phone.")
            } else {
                Text("It leaves your list and no longer counts toward the map. Controllers can still see that you withdrew it.")
            }
        }
    }

    private func summary(_ target: ReportEditTarget) -> some View {
        let report = target.report
        let place = target.location.flatMap { store.placeWords($0.coord, road: report?.roadRef?.name) }
            ?? report?.roadRef?.name
        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                KindBadge(kind: target.kind)
                VStack(alignment: .leading, spacing: 4) {
                    Text(target.kind.title)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Color.ctInk)
                        .fixedSize(horizontal: false, vertical: true)
                    if let severity = target.severity, target.kind.hasSeverity {
                        Text(severity.title)
                            .font(.subheadline)
                            .foregroundStyle(Color.ctInk)
                    }
                    if let place {
                        Text(place)
                            .font(.subheadline)
                            .foregroundStyle(Color.ctInkMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    HStack(spacing: 8) {
                        Text("Seen \(target.observedAt.formatted(.dateTime.hour().minute()))")
                            .font(.footnote)
                            .monospacedDigit()
                            .foregroundStyle(Color.ctInkMuted)
                        if report?.editedAt != nil { EditedTag() }
                    }
                }
            }
            ReportSteps(progress: report.map { store.progress(of: $0) })
                .padding(.leading, 42)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .ctPanel(padding: 0)
        .accessibilityElement(children: .combine)
    }

    private func notePanel(_ note: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Note")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Color.ctInkMuted)
            Text(note)
                .font(.body)
                .foregroundStyle(Color.ctInk)
                .fixedSize(horizontal: false, vertical: true)
        }
        .ctPanel()
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func actions(_ target: ReportEditTarget) -> some View {
        if target.isEditable {
            VStack(spacing: 12) {
                if let message {
                    Label(message, systemImage: message == Self.lockedLine ? "lock.fill" : "exclamationmark.triangle.fill")
                        .font(.subheadline)
                        .foregroundStyle(Color.ctWarning)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if target.canEdit {
                    Button {
                        tick += 1
                        message = nil
                        editing = target
                    } label: {
                        Label("Edit", systemImage: "pencil")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(FieldPill(primary: true))
                    .disabled(deleting)
                }

                Button(role: .destructive) {
                    confirmingDelete = true
                } label: {
                    Text(deleting ? "Deleting" : "Delete report")
                        .font(.body.weight(.medium))
                        .foregroundStyle(Color.ctDanger)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .disabled(deleting)
            }
        } else {
            Label(Self.lockedLine, systemImage: "lock.fill")
                .font(.subheadline)
                .foregroundStyle(Color.ctInkMuted)
                .fixedSize(horizontal: false, vertical: true)
                .ctPanel()
        }
    }

    private func delete() {
        guard let target = current, !deleting else { return }
        message = nil
        switch target {
        case .draft(let draft):
            do {
                try store.deleteDraft(draft)
                dismiss()
            } catch {
                message = error.localizedDescription
            }
        case .report(let report):
            deleting = true
            Task {
                defer { deleting = false }
                do {
                    try await store.withdrawReport(report)
                    dismiss()
                } catch is CancellationError {
                } catch {
                    message = error.localizedDescription
                }
            }
        }
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
        VStack(alignment: .leading, spacing: 12) {
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
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .sensoryFeedback(.selection, trigger: tick)
        .accessibilityElement(children: .contain)
    }

    private func answer(_ stillThere: Bool) {
        tick += 1
        withAnimation(.snappy) { store.answerStillThere(item, stillThere: stillThere) }
    }
}

/// A board question about a road or shelter, answered in one tap; same card as `StillThereCard`.
private struct BoardQuestionCard: View {
    let question: BoardQuestion

    @Environment(LiveStore.self) private var store
    @State private var tick = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: question.symbol)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.ctInkMuted)
                    .frame(width: 30, height: 30)
                    .background(Color.ctSurfaceMuted, in: .circle)
                    .accessibilityHidden(true)
                Text(question.title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Color.ctInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 8) {
                ForEach(Array(question.answers.enumerated()), id: \.element) { index, answer in
                    Button(answer.title) {
                        tick += 1
                        withAnimation(.snappy) { store.answerBoard(question, answer) }
                    }
                    .buttonStyle(FieldPill(primary: index == 0))
                }
            }
            .padding(.leading, 42)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .sensoryFeedback(.selection, trigger: tick)
        .accessibilityElement(children: .contain)
    }
}
