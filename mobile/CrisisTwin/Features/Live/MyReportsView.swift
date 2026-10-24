import SwiftUI

/// This device's reports: drafts still on the phone first, then what the server has accepted.
struct MyReportsView: View {
    @Environment(LiveStore.self) private var store

    var body: some View {
        List {
            if store.pending.isEmpty && store.myReports.isEmpty {
                Section {
                    ContentUnavailableView(
                        "No reports yet",
                        systemImage: "list.bullet.rectangle",
                        description: Text("Reports you send appear here.")
                    )
                    .listRowBackground(Color.clear)
                }
            }

            if !store.pending.isEmpty {
                Section("On this phone") {
                    ForEach(store.pending) { draft in
                        row(kind: draft.kind, road: nil, time: draft.observedAt, status: "Waiting to send", systemImage: "clock", tone: .caution)
                    }
                }
            }

            if !store.myReports.isEmpty {
                Section {
                    ForEach(store.myReports) { report in
                        row(
                            kind: report.kind,
                            road: report.roadRef?.name,
                            time: report.observedAt,
                            status: report.status.title,
                            systemImage: report.status.pillSymbol,
                            tone: report.status.pillTone
                        )
                    }
                } header: {
                    Text("Sent")
                } footer: {
                    footer
                }
            } else {
                Section { } footer: { footer }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Color.ctBackground)
        .navigationTitle("My reports")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.refresh() }
    }

    private func row(kind: ReportKind, road: String?, time: Date, status: String, systemImage: String, tone: HazardTone) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: kind.systemImage)
                .font(.body.weight(.semibold))
                .foregroundStyle(kind.tone.color)
                .frame(width: 40, height: 40)
                .background(kind.tone.color.opacity(0.12), in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text(kind.title).font(.headline).foregroundStyle(Color.ctInk)
                    Spacer(minLength: 8)
                    Text(time, format: .relative(presentation: .named))
                        .font(.footnote)
                        .foregroundStyle(Color.ctMuted)
                }
                if let road, !road.isEmpty {
                    Text(road).font(.subheadline).foregroundStyle(Color.ctMuted)
                }
                StatusPill(text: status, systemImage: systemImage, tone: tone)
            }
        }
        .padding(.vertical, 6)
        .frame(minHeight: 44)
        .listRowBackground(Color.ctSurface)
        .accessibilityElement(children: .combine)
    }

    private var footer: some View {
        Text("Only reports confirmed by several independent people appear on the public map. Follow official orders first.")
            .font(.footnote)
            .foregroundStyle(Color.ctMuted)
            .padding(.top, 8)
    }
}

extension ReportStatus {
    /// Pill styling for a report's status. The status text always accompanies the tone.
    var pillTone: HazardTone {
        switch self {
        case .unverified: return .caution
        case .corroborated, .responderConfirmed, .confirmed: return .clear
        case .dismissed, .resolved: return .info
        }
    }

    var pillSymbol: String {
        switch self {
        case .unverified: return "questionmark.circle"
        case .corroborated, .responderConfirmed, .confirmed: return "checkmark.seal"
        case .dismissed: return "xmark.circle"
        case .resolved: return "archivebox"
        }
    }
}

#Preview {
    NavigationStack { MyReportsView() }
        .environment(LiveStore())
}
