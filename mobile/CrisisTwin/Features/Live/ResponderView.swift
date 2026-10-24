import CoreLocation
import SwiftUI

/// Plan > Join as responder: exchange an invite code for a responder credential; once joined,
/// location sharing and leaving.
struct JoinResponderView: View {
    @Environment(LiveStore.self) private var store
    @State private var inviteCode = ""
    @State private var joining = false
    @State private var errorMessage: String?
    @State private var joinedTick = 0

    private var trimmedCode: String { inviteCode.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        @Bindable var store = store
        List {
            if store.role == .civilian {
                Section {
                    TextField("Invite code", text: $inviteCode)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .submitLabel(.join)
                        .onSubmit(join)
                        .frame(minHeight: 44)
                    if let errorMessage {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.secondary)
                    }
                }
                Section {
                    Button(action: join) {
                        HStack {
                            Text("Join as responder")
                            Spacer()
                            if joining { ProgressView() }
                        }
                        .frame(minHeight: 44)
                    }
                    .disabled(joining || trimmedCode.isEmpty)
                }
            } else {
                Section {
                    Toggle(isOn: $store.shareResponderLocation) {
                        Label("Share my location", systemImage: "location")
                    }
                    .frame(minHeight: 44)
                }
                Section {
                    Button("Leave responder mode", role: .destructive) { store.leaveResponderRole() }
                        .frame(minHeight: 44)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Responder")
        .sensoryFeedback(.success, trigger: joinedTick)
    }

    private func join() {
        guard !trimmedCode.isEmpty, !joining else { return }
        joining = true
        errorMessage = nil
        Task {
            do {
                try await store.joinAsResponder(inviteCode: trimmedCode)
                inviteCode = ""
                joinedTick += 1
            } catch {
                errorMessage = error.localizedDescription
            }
            joining = false
        }
    }
}

/// The Tasks tab (responders): places the controller asked to check. Swipe to accept, answer
/// or say it can't be reached; tap to see the place on Map.
struct TasksView: View {
    @Environment(LiveStore.self) private var store
    @Environment(AppRouter.self) private var router
    @Environment(\.reportZoom) private var reportZoom
    @State private var cancelling: CheckTask?
    @State private var cancelNote = ""
    @State private var errorMessage: String?
    @State private var successTick = 0
    @State private var errorTick = 0

    var body: some View {
        NavigationStack {
            List {
                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.secondary)
                    }
                }
                if store.tasks.isEmpty {
                    ContentUnavailableView("No checks right now", systemImage: "checklist")
                        .listRowBackground(Color.clear)
                } else {
                    Section {
                        ForEach(store.tasks) { task in
                            Button {
                                router.showOnMap(store.taskTarget(task))
                            } label: {
                                row(task)
                            }
                            .buttonStyle(.plain)
                            .reportZoomSource("task-\(task.id)", in: reportZoom)
                            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                                if task.status == .accepted {
                                    Button("Answer", systemImage: "square.and.pencil") {
                                        router.openReport(
                                            ReportPrefill(kind: nil, coord: store.taskTarget(task), taskId: task.id),
                                            from: "task-\(task.id)")
                                    }
                                    .tint(.ctRoute)
                                } else {
                                    Button("Accept", systemImage: "checkmark") { accept(task) }
                                        .tint(.ctRoute)
                                }
                            }
                            .swipeActions(edge: .trailing) {
                                Button("Can't reach", systemImage: "xmark") {
                                    cancelNote = ""
                                    cancelling = task
                                }
                                .tint(.gray)
                            }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Tasks")
            .toolbar {
                if store.isExercise {
                    ToolbarItem(placement: .topBarTrailing) { ExerciseTag() }
                }
            }
            .refreshable { await store.refresh() }
            .sensoryFeedback(.success, trigger: successTick)
            .sensoryFeedback(.error, trigger: errorTick)
            .alert("Can't reach it", isPresented: Binding(
                get: { cancelling != nil }, set: { if !$0 { cancelling = nil } })
            ) {
                TextField("Why not? (optional)", text: $cancelNote)
                Button("Send") { submitCancel() }
                Button("Back", role: .cancel) {}
            }
        }
    }

    private func row(_ task: CheckTask) -> some View {
        let kind = targetKind(task)
        return HStack(spacing: 12) {
            Image(systemName: kind?.systemImage ?? "magnifyingglass")
                .foregroundStyle(kind?.symbolColor ?? Color.secondary)
                .frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("Check \(store.targetName(task))")
                    .fixedSize(horizontal: false, vertical: true)
                if task.status == .accepted {
                    Label("Accepted", systemImage: "checkmark.circle.fill")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else if let note = task.note, !note.isEmpty {
                    Text(note)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                if let distance = distanceText(task) {
                    Text(distance).monospacedDigit()
                }
                Text(task.createdAt, format: .relative(presentation: .named))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(minHeight: 44)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Shows it on the map")
    }

    /// The kind of hazard on the task's road segment, when known.
    private func targetKind(_ task: CheckTask) -> ReportKind? {
        guard let id = task.target.segmentId else { return nil }
        return store.situation?.hazards.first { $0.roadRef?.segmentId == id }?.kind
            ?? store.allReports.first { $0.roadRef?.segmentId == id }?.kind
    }

    /// On-device distance from the last fix to the task target.
    private func distanceText(_ task: CheckTask) -> String? {
        guard let here = store.lastCoord, let target = store.taskTarget(task) else { return nil }
        let meters = CLLocation(latitude: here.lat, longitude: here.lon)
            .distance(from: CLLocation(latitude: target.lat, longitude: target.lon))
        return Measurement(value: meters, unit: UnitLength.meters)
            .formatted(.measurement(width: .abbreviated, usage: .road))
    }

    private func accept(_ task: CheckTask) {
        errorMessage = nil
        Task {
            do {
                try await store.acceptTask(task)
                successTick += 1
            } catch LiveAPIError.conflict {
                errorMessage = "Another responder took this task."
                errorTick += 1
                await store.refresh()
            } catch {
                errorMessage = error.localizedDescription
                errorTick += 1
            }
        }
    }

    private func submitCancel() {
        guard let task = cancelling else { return }
        let note = cancelNote.trimmingCharacters(in: .whitespacesAndNewlines)
        errorMessage = nil
        Task {
            do {
                try await store.cancelTask(task, note: note.isEmpty ? "Could not reach it" : note)
                successTick += 1
                await store.refresh()
            } catch {
                errorMessage = error.localizedDescription
                errorTick += 1
            }
        }
    }
}
