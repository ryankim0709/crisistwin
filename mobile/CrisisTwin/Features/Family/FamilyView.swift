import SwiftUI

/// Create or join a family, share its code, post your status and see everyone else's.
/// Meeting points are edited in My Plan and shared with the family from there.
struct FamilyView: View {
    let openTab: (AppTab) -> Void

    @Environment(FamilyStore.self) private var store
    @Environment(MeetingPlanStore.self) private var planStore
    @State private var mode: Mode = .create
    @State private var familyName = ""
    @State private var memberName = ""
    @State private var joinCode = ""
    @State private var confirmingLeave = false

    private enum Mode: String, CaseIterable, Identifiable {
        case create = "Create", join = "Join"
        var id: String { rawValue }
    }

    var body: some View {
        List {
            if let message = store.errorMessage {
                Section {
                    Label(message, systemImage: "exclamationmark.triangle")
                }
            }
            if let family = store.family {
                joined(family)
            } else if store.isJoined {
                Section { ProgressView("Loading your family…") }
            } else {
                enrollment
            }
        }
        .navigationTitle("Family")
        .refreshable { await store.refresh() }
        .disabled(store.isWorking)
        .confirmationDialog("Leave this family?", isPresented: $confirmingLeave, titleVisibility: .visible) {
            Button("Leave family", role: .destructive) { Task { await store.leave() } }
        } message: {
            Text("Your meeting points stay on this phone. You can rejoin with the code.")
        }
    }

    // MARK: Not in a family

    private var enrollment: some View {
        Group {
            Section {
                Picker("Create or join", selection: $mode) {
                    ForEach(Mode.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
            }
            Section {
                TextField("Your name, e.g. Sam", text: $memberName)
                    .textContentType(.givenName)
                if mode == .create {
                    TextField("Family name, e.g. The Parks", text: $familyName)
                } else {
                    TextField("Join code, e.g. ABCD-EFGH", text: $joinCode)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                }
                Button {
                    Task { await submit() }
                } label: {
                    if store.isWorking {
                        ProgressView()
                    } else {
                        Label(mode == .create ? "Create family" : "Join family", systemImage: mode == .create ? "person.3.fill" : "person.badge.plus")
                    }
                }
                .disabled(!canSubmit)
            } footer: {
                Text(mode == .create
                     ? "You get a code to share with your household. Your current meeting points become the family's."
                     : "Ask a family member for the code on their Family tab. The family's meeting points replace the ones on this phone.")
            }
        }
    }

    private var canSubmit: Bool {
        let name = memberName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, !store.isWorking else { return false }
        if mode == .create { return !familyName.trimmingCharacters(in: .whitespaces).isEmpty }
        return joinCode.filter { $0.isLetter || $0.isNumber }.count == 8
    }

    private func submit() async {
        let name = memberName.trimmingCharacters(in: .whitespaces)
        if mode == .create {
            guard await store.create(familyName: familyName.trimmingCharacters(in: .whitespaces), memberName: name) else { return }
            // Seed the new family with the points this phone already has.
            let plan = planStore.plan
            if plan.primary != nil {
                await store.setMeetingPoints(primary: plan.primary, backup: plan.backup)
            }
        } else {
            _ = await store.join(code: joinCode, memberName: name)
        }
    }

    // MARK: In a family

    @ViewBuilder
    private func joined(_ family: Family) -> some View {
        Section {
            LabeledContent("Join code") {
                Text(family.displayJoinCode)
                    .font(.title3.monospaced().bold())
                    .textSelection(.enabled)
            }
            ShareLink(item: family.inviteText) {
                Label("Invite family members", systemImage: "square.and.arrow.up")
            }
        } header: {
            Text(family.name)
        } footer: {
            Text("Anyone with this code can join and see the members, meeting points and status.")
        }

        if let me = family.members.first(where: \.isMe) {
            Section {
                ForEach(MemberStatus.allCases.filter { $0 != .unknown }) { status in
                    Button {
                        Task { await store.setStatus(status) }
                    } label: {
                        HStack {
                            Label(status.label, systemImage: status.systemImage)
                                .foregroundStyle(status == .needHelp ? Color.red : Color.primary)
                            Spacer()
                            if me.memberStatus == status {
                                Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
                                    .accessibilityLabel("Current status")
                            }
                        }
                    }
                }
            } header: {
                Text("My status")
            } footer: {
                Text("“Need help” only tells your family. Call 911 if you are in danger.")
            }
        }

        Section("Members") {
            ForEach(family.members) { member in
                HStack {
                    VStack(alignment: .leading) {
                        Text(member.isMe ? "\(member.name) (you)" : member.name)
                        if let date = ServerDate.parse(member.statusUpdatedAt), member.memberStatus != .unknown {
                            Text("Updated \(date.formatted(.relative(presentation: .named)))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Label(member.memberStatus.label, systemImage: member.memberStatus.systemImage)
                        .font(.subheadline)
                        .foregroundStyle(member.memberStatus == .needHelp ? Color.red : Color.secondary)
                }
                .accessibilityElement(children: .combine)
            }
        }

        Section {
            LabeledContent("Primary", value: family.primary?.name ?? "Not chosen")
            LabeledContent("Backup", value: family.backup?.name ?? "Not chosen")
            if let by = family.meetingPointsUpdatedBy {
                Text("Last changed by \(by)").font(.caption).foregroundStyle(.secondary)
            }
            Button(family.primary == nil ? "Choose meeting points" : "Change meeting points") { openTab(.plan) }
        } header: {
            Text("Shared meeting points")
        } footer: {
            Text("Changes in My Plan are shared with everyone in the family.")
        }

        Section {
            Button("Leave family", role: .destructive) { confirmingLeave = true }
        }
    }
}
