import SwiftUI

/// What a person sees of their report's progress: four plain steps (D6).
enum ReportProgress: Equatable {
    case received, beingChecked, confirmed, resolved

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
}

extension LiveStore {
    /// The step to show for one of this device's reports.
    func progress(of report: FieldReport) -> ReportProgress {
        let open = (situation?.tasks ?? tasks).contains {
            ($0.status == .open || $0.status == .accepted) && $0.reportIds.contains(report.id)
        }
        return ReportProgress(report.status, hasOpenTask: open)
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
            List {
                Section {
                    Button {
                        router.openReport(from: "reports-new")
                    } label: {
                        Label("New report", systemImage: "plus")
                            .font(.headline)
                            .foregroundStyle(Color(uiColor: .systemBackground))
                            .frame(maxWidth: .infinity, minHeight: 50)
                    }
                    .buttonStyle(.glassProminent)
                    .reportZoomSource("reports-new", in: reportZoom)
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)

                let questions = store.stillThereItems
                if !questions.isEmpty {
                    Section("Still there?") {
                        ForEach(questions) { StillThereRow(item: $0) }
                    }
                }

                if !store.pending.isEmpty || !store.myReports.isEmpty {
                    Section("Yours") {
                        ForEach(store.pending) { draft in
                            row(kind: draft.kind, road: nil, time: draft.observedAt,
                                word: "Waiting to send", symbol: "clock", confirmed: false)
                        }
                        ForEach(store.myReports) { report in
                            let progress = store.progress(of: report)
                            row(kind: report.kind, road: report.roadRef?.name, time: report.observedAt,
                                word: progress.word, symbol: progress.symbol, confirmed: progress == .confirmed)
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Reports")
            .toolbar {
                if store.isExercise {
                    ToolbarItem(placement: .topBarTrailing) { ExerciseTag() }
                }
            }
            .refreshable { await store.refresh() }
            .animation(.snappy, value: store.stillThereItems.map(\.id))
        }
    }

    private func row(kind: ReportKind, road: String?, time: Date, word: String, symbol: String,
                     confirmed: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: kind.systemImage)
                .foregroundStyle(kind.symbolColor)
                .frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text([kind.title, road].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", "))
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    if confirmed {
                        Image(systemName: symbol).transition(.symbolEffect(.drawOn))
                    } else {
                        Image(systemName: symbol)
                    }
                    Text(word)
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .animation(.easeInOut, value: symbol)
            }
            Spacer(minLength: 8)
            Text(time, format: .dateTime.hour().minute())
                .font(.footnote)
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}
