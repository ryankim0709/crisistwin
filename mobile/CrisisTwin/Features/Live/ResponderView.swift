import SwiftUI

/// Join with an invite code, or (as a responder) see check tasks and answer them.
struct ResponderView: View {
    var onReport: (ReportPrefill?) -> Void = { _ in }

    @Environment(LiveStore.self) private var store
    @State private var inviteCode = ""
    @State private var joining = false
    @State private var errorMessage: String?
    @State private var cancelling: CheckTask?
    @State private var cancelNote = ""

    var body: some View {
        List {
            if store.role == .civilian { joinSections } else { responderSections }
        }
        .scrollContentBackground(.hidden)
        .background(Color.ctBackground)
        .navigationTitle(store.role == .civilian ? "Responder" : "Tasks")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.refresh() }
        .alert("Can't reach it", isPresented: Binding(
            get: { cancelling != nil }, set: { if !$0 { cancelling = nil } })
        ) {
            TextField("Why not? (optional)", text: $cancelNote)
            Button("Send") { submitCancel() }
            Button("Back", role: .cancel) {}
        } message: {
            Text("The controller will see that this check was not done.")
        }
    }

    @ViewBuilder private var joinSections: some View {
        Section {
            VStack(alignment: .leading, spacing: 10) {
                Image(systemName: "person.badge.shield.checkmark.fill")
                    .font(.title2)
                    .foregroundStyle(Color.ctBrand)
                    .frame(width: 48, height: 48)
                    .background(Color.ctBrand.opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .accessibilityHidden(true)
                Text("For people the incident controller asked to check roads and places. Enter your invite code.")
                    .font(.subheadline)
                    .foregroundStyle(Color.ctInk)
            }
            .padding(.vertical, 6)
            .listRowBackground(Color.ctSurface)
        }
        Section {
            TextField("Invite code", text: $inviteCode)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .font(.body.monospaced())
                .frame(minHeight: 44)
                .listRowBackground(Color.ctSurface)
            if let errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(HazardTone.danger.color)
                    .listRowBackground(Color.ctSurface)
            }
        }
        Section {
            Button {
                join()
            } label: {
                HStack {
                    Text("Join as responder")
                    if joining { ProgressView() }
                }
            }
            .buttonStyle(PrimaryButtonStyle(tint: inviteCode.trimmingCharacters(in: .whitespaces).isEmpty
                                            ? Color.ctMuted.opacity(0.45) : .ctBrand))
            .disabled(joining || inviteCode.trimmingCharacters(in: .whitespaces).isEmpty)
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
        }
    }

    @ViewBuilder private var responderSections: some View {
        Section("Places to check") {
            if store.tasks.isEmpty {
                Text("No check requests right now.").foregroundStyle(Color.ctMuted)
                    .listRowBackground(Color.ctSurface)
            }
            ForEach(store.tasks) { task in taskRow(task) }
        }
        if let errorMessage {
            Section {
                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(HazardTone.danger.color)
                    .listRowBackground(Color.ctSurface)
            }
        }
        Section {
            Button("Leave responder mode", role: .destructive) { store.leaveResponderRole() }
                .frame(minHeight: 44)
                .listRowBackground(Color.ctSurface)
        }
    }

    private func targetText(_ task: CheckTask) -> String {
        if let id = task.target.segmentId {
            let name = store.allReports.first { $0.roadRef?.segmentId == id }?.roadRef?.name
                ?? store.publicItems.first { $0.roadRef?.segmentId == id }?.roadRef?.name
            if let name { return name }
        }
        if let c = task.target.coord { return String(format: "Near %.4f, %.4f", c.lat, c.lon) }
        return "Place not given"
    }

    private func taskRow(_ task: CheckTask) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "magnifyingglass")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(HazardTone.info.color)
                    .frame(width: 40, height: 40)
                    .background(HazardTone.info.color.opacity(0.12), in: Circle())
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Check: \(targetText(task))").font(.headline).foregroundStyle(Color.ctInk)
                    if let note = task.note, !note.isEmpty {
                        Text(note).font(.subheadline).foregroundStyle(Color.ctInk)
                    }
                    Text("Asked \(Text(task.createdAt, style: .relative)) ago")
                        .font(.footnote).foregroundStyle(Color.ctMuted)
                }
            }
            HStack(spacing: 10) {
                Button {
                    onReport(ReportPrefill(kind: nil, coord: task.target.coord, taskId: task.id))
                } label: {
                    Text("Answer")
                }
                .buttonStyle(LiveCompactButtonStyle(filled: true))
                Button {
                    cancelNote = ""
                    cancelling = task
                } label: {
                    Text("Can't reach it")
                }
                .buttonStyle(LiveCompactButtonStyle(filled: false))
            }
        }
        .padding(.vertical, 6)
        .listRowBackground(Color.ctSurface)
    }

    private func join() {
        joining = true
        errorMessage = nil
        Task {
            do {
                try await store.joinAsResponder(inviteCode: inviteCode.trimmingCharacters(in: .whitespacesAndNewlines))
                inviteCode = ""
            } catch {
                errorMessage = error.localizedDescription
            }
            joining = false
        }
    }

    private func submitCancel() {
        guard let task = cancelling else { return }
        let note = cancelNote.trimmingCharacters(in: .whitespacesAndNewlines)
        errorMessage = nil
        Task {
            do {
                try await store.cancelTask(task, note: note.isEmpty ? "Could not reach it" : note)
                await store.refresh()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

#Preview {
    NavigationStack { ResponderView() }
        .environment(LiveStore())
}
