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
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if store.role == .civilian {
                    VStack(alignment: .leading, spacing: 12) {
                        TextField("Invite code", text: $inviteCode)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .submitLabel(.join)
                            .onSubmit(join)
                            .font(.body.monospaced())
                            .padding(.horizontal, 12)
                            .frame(minHeight: 48)
                            .background(Color.ctSurfaceSunken, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Color.ctBorderSubtle))
                        if let errorMessage {
                            Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                                .font(.subheadline)
                                .foregroundStyle(Color.ctDanger)
                        }
                        Button(action: join) {
                            HStack(spacing: 8) {
                                if joining { ProgressView().tint(Color.ctBackground) }
                                Text("Join as responder")
                            }
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(FieldPill(primary: true, minHeight: 50))
                        .disabled(joining || trimmedCode.isEmpty)
                        .opacity(trimmedCode.isEmpty ? 0.5 : 1)
                    }
                    .ctPanel(padding: 14)
                } else {
                    Toggle(isOn: $store.shareResponderLocation) {
                        Label("Share my location", systemImage: "location")
                            .foregroundStyle(Color.ctInk)
                    }
                    .tint(Color.ctBrand)
                    .frame(minHeight: 44)
                    .ctPanel(padding: 14)
                    Button("Leave responder mode", role: .destructive) { store.leaveResponderRole() }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.ctDanger)
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .background(Color.ctDangerSoft, in: .capsule)
                        .buttonStyle(.plain)
                }
            }
            .padding(16)
        }
        .ctScreenBackground()
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

/// The Tasks tab (responders): places the controller asked to check, each with its actions:
/// accept (then answer), show on Map, or say it can't be reached.
struct TasksView: View {
    @Environment(LiveStore.self) private var store
    @Environment(AppRouter.self) private var router
    @Environment(\.reportZoom) private var reportZoom
    @State private var cancelling: CheckTask?
    @State private var cancelNote = ""
    @State private var errorMessage: String?
    @State private var busy: String?
    @State private var successTick = 0
    @State private var errorTick = 0

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let errorMessage {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(.subheadline)
                            .foregroundStyle(Color.ctDanger)
                            .padding(12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color.ctDangerSoft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    if store.tasks.isEmpty {
                        ContentUnavailableView("No checks right now", systemImage: "checklist")
                            .foregroundStyle(Color.ctInkMuted)
                            .padding(.top, 80)
                    } else {
                        ForEach(store.tasks) { task in card(task) }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .ctScreenBackground()
            .navigationTitle("Tasks")
            .toolbar {
                if store.isExercise {
                    ToolbarItem(placement: .largeSubtitle) {
                        ExerciseTag().frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .refreshable { await store.refresh() }
            .animation(.snappy, value: store.tasks.map(\.id))
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

    private func card(_ task: CheckTask) -> some View {
        let kind = targetKind(task)
        let accepted = task.status == .accepted
        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                if let kind, !task.isAssist {
                    KindBadge(kind: kind)
                } else {
                    Image(systemName: task.isAssist ? "hand.raised.fill" : "magnifyingglass")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Color.ctInkMuted)
                        .frame(width: 30, height: 30)
                        .background(Color.ctSurfaceMuted, in: .circle)
                        .accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(task.isAssist ? "Help a resident" : "Check \(placeName(task))")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(Color.ctInk)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 8)
                        if let distance = distanceText(task) {
                            Text(distance)
                                .font(.subheadline.weight(.semibold))
                                .monospacedDigit()
                                .foregroundStyle(Color.ctInk)
                        }
                    }
                    if let note = task.note, !note.isEmpty {
                        Text(note)
                            .font(.subheadline)
                            .foregroundStyle(Color.ctInkMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    HStack(spacing: 8) {
                        if accepted { AcceptedTag() }
                        Text(task.createdAt, format: .relative(presentation: .named))
                            .font(.footnote)
                            .foregroundStyle(Color.ctInkMuted)
                    }
                }
            }
            .accessibilityElement(children: .combine)

            HStack(spacing: 8) {
                if accepted && task.isAssist {
                    Button { complete(task) } label: {
                        HStack(spacing: 6) {
                            if busy == task.id { ProgressView().controlSize(.small).tint(Color.ctBackground) }
                            Label("Done", systemImage: "checkmark")
                        }
                    }
                    .buttonStyle(FieldPill(primary: true))
                    .disabled(busy != nil)
                } else if accepted {
                    Button {
                        router.openReport(
                            ReportPrefill(kind: nil, coord: store.taskTarget(task), taskId: task.id),
                            from: "task-\(task.id)")
                    } label: {
                        Label("Answer", systemImage: "square.and.pencil")
                    }
                    .buttonStyle(FieldPill(primary: true))
                    .reportZoomSource("task-\(task.id)", in: reportZoom)
                } else {
                    Button { accept(task) } label: {
                        HStack(spacing: 6) {
                            if busy == task.id { ProgressView().controlSize(.small).tint(Color.ctBackground) }
                            Text("Accept")
                        }
                    }
                    .buttonStyle(FieldPill(primary: true))
                    .disabled(busy != nil)
                }
                Button {
                    router.showOnMap(store.taskTarget(task))
                } label: {
                    Image(systemName: "map")
                }
                .buttonStyle(FieldPill())
                .accessibilityLabel("Show on map")
                .disabled(store.taskTarget(task) == nil)
                Spacer(minLength: 0)
                Button("Can't reach") {
                    cancelNote = ""
                    cancelling = task
                }
                .buttonStyle(FieldPill())
            }
            .padding(.leading, 42)
        }
        .ctPanel(padding: 14)
    }

    /// The road the task points at, else a known road near its target.
    private func placeName(_ task: CheckTask) -> String {
        let name = store.targetName(task)
        guard task.target.segmentId == nil || name == "the marked place",
              let target = store.taskTarget(task) else { return name }
        return store.allReports.first { task.reportIds.contains($0.id) }?.roadRef?.name
            ?? store.nearestRoad(to: target) ?? name
    }

    /// The kind of hazard the task is about: its linked report, else its road segment's.
    private func targetKind(_ task: CheckTask) -> ReportKind? {
        if let kind = store.allReports.first(where: { task.reportIds.contains($0.id) })?.kind { return kind }
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
        busy = task.id
        Task {
            defer { busy = nil }
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

    private func complete(_ task: CheckTask) {
        errorMessage = nil
        busy = task.id
        Task {
            defer { busy = nil }
            do {
                try await store.completeTask(task)
                successTick += 1
            } catch {
                errorMessage = error.localizedDescription
                errorTick += 1
                await store.refresh()
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

/// The web kit's success Tag: this responder took the task.
private struct AcceptedTag: View {
    var body: some View {
        Label("Accepted", systemImage: "checkmark")
            .labelStyle(.titleAndIcon)
            .font(.caption.weight(.semibold))
            .foregroundStyle(Color.ctSuccess)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Color.ctSuccessSoft, in: .capsule)
            .overlay(Capsule().strokeBorder(Color.ctSuccess.opacity(0.3)))
    }
}
