import SwiftUI

/// Create or join a family, share its code, post your status and see everyone else's.
/// Meeting points are edited in Plan and shared with the family from there.
struct FamilyView: View {
    enum Mode: String, CaseIterable, Identifiable {
        case create = "Create", join = "Join"
        var id: String { rawValue }
    }

    let openTab: (AppTab) -> Void

    @Environment(FamilyStore.self) private var store
    @Environment(MeetingPlanStore.self) private var planStore
    @State private var mode: Mode
    @State private var familyName = ""
    @State private var memberName = ""
    @State private var joinCode = ""
    @State private var confirmingLeave = false
    @State private var tick = 0

    init(openTab: @escaping (AppTab) -> Void, initialMode: Mode = .create) {
        self.openTab = openTab
        _mode = State(initialValue: initialMode)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if let message = store.errorMessage {
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .font(.subheadline)
                        .foregroundStyle(Color.ctWarning)
                        .ctPanel()
                }
                if let family = store.family {
                    joined(family)
                } else if store.isJoined {
                    ProgressView()
                        .frame(maxWidth: .infinity, minHeight: 120)
                } else {
                    enrollment
                }
            }
            .ctScreenPadding()
        }
        .ctScreenBackground()
        .navigationTitle(store.family?.name ?? "Family")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.refresh() }
        .disabled(store.isWorking)
        .sensoryFeedback(.selection, trigger: tick)
        .confirmationDialog("Leave this family?", isPresented: $confirmingLeave, titleVisibility: .visible) {
            Button("Leave family", role: .destructive) { Task { await store.leave() } }
        } message: {
            Text("Your meeting points stay on this phone. You can rejoin with the code.")
        }
    }

    // MARK: Not in a family

    private var enrollment: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker("Create or join", selection: $mode) {
                ForEach(Mode.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)

            FamilyField(title: "Your name", text: $memberName, prompt: "Sam")
                .textContentType(.givenName)
            if mode == .create {
                FamilyField(title: "Family name", text: $familyName, prompt: "The Parks")
            } else {
                FamilyField(title: "Join code", text: $joinCode, prompt: "ABCD-EFGH", monospaced: true)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
            }

            Button {
                Task { await submit() }
            } label: {
                if store.isWorking {
                    ProgressView().tint(Color.planOnBrand)
                } else {
                    Label(mode == .create ? "Create family" : "Join family",
                          systemImage: mode == .create ? "person.3.fill" : "person.badge.plus")
                }
            }
            .buttonStyle(PlanPillStyle(kind: .primary, fullWidth: true))
            .disabled(!canSubmit)

            if mode == .join {
                Text("Joining replaces this phone's meeting points.")
                    .font(.footnote)
                    .foregroundStyle(Color.ctInkMuted)
            }
        }
        .ctPanel()
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
        // The join code, as large as a code read aloud needs to be.
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Join code")
                        .font(.subheadline)
                        .foregroundStyle(Color.ctInkMuted)
                    Text(family.displayJoinCode)
                        .font(.system(.title, design: .monospaced, weight: .semibold))
                        .foregroundStyle(Color.ctInk)
                        .textSelection(.enabled)
                        .minimumScaleFactor(0.7)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                ShareLink(item: family.inviteText) {
                    Label("Invite", systemImage: "person.badge.plus")
                }
                .buttonStyle(PlanPillStyle(kind: .primary))
            }
            Text("Anyone with the code can join and see members, meeting points and status.")
                .font(.footnote)
                .foregroundStyle(Color.ctInkMuted)
        }
        .ctPanel()

        if let me = family.members.first(where: \.isMe) {
            VStack(alignment: .leading, spacing: 12) {
                PlanCardHeader("My status")
                let columns = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]
                LazyVGrid(columns: columns, spacing: 8) {
                    ForEach(MemberStatus.allCases.filter { $0 != .unknown }) { status in
                        statusChoice(status, selected: me.memberStatus == status)
                    }
                }
                Text("Need help reaches your family only. If you are in danger, call 911.")
                    .font(.footnote)
                    .foregroundStyle(Color.ctInkMuted)
            }
            .ctPanel()
        }

        VStack(alignment: .leading, spacing: 8) {
            PlanCardHeader("Members")
            VStack(spacing: 0) {
                ForEach(Array(family.members.enumerated()), id: \.element.id) { index, member in
                    if index > 0 { PlanRowDivider(leading: 48) }
                    FamilyMemberRow(member: member)
                }
            }
        }
        .ctPanel()

        VStack(alignment: .leading, spacing: 8) {
            PlanCardHeader("Shared meeting points")
            sharedPoint(.primary, family.primary)
            PlanRowDivider(leading: 48)
            sharedPoint(.backup, family.backup)
            if let by = family.meetingPointsUpdatedBy {
                Text("Last changed by \(by)")
                    .font(.footnote)
                    .foregroundStyle(Color.ctInkMuted)
            }
            Button(family.primary == nil ? "Choose meeting points" : "Change meeting points") { openTab(.plan) }
                .buttonStyle(PlanPillStyle(kind: .secondary, fullWidth: true))
                .padding(.top, 4)
        }
        .ctPanel()

        Button(role: .destructive) {
            confirmingLeave = true
        } label: {
            Text("Leave family")
                .font(.body.weight(.medium))
                .foregroundStyle(Color.ctDanger)
                .frame(maxWidth: .infinity, minHeight: 44)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }

    private func statusChoice(_ status: MemberStatus, selected: Bool) -> some View {
        Button {
            tick += 1
            Task { await store.setStatus(status) }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: status.systemImage)
                    .foregroundStyle(selected ? status.planTone : Color.ctInkMuted)
                    .frame(width: 22)
                    .accessibilityHidden(true)
                Text(status.label)
                    .font(.subheadline.weight(selected ? .semibold : .regular))
                    .foregroundStyle(selected ? status.planTone : Color.ctInk)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if selected {
                    Image(systemName: "checkmark")
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(status.planTone)
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            .background(selected ? status.planSoft : Color.ctSurfaceSunken,
                        in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(selected ? status.planTone.opacity(0.45) : Color.ctBorderSubtle, lineWidth: 1))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(status.label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func sharedPoint(_ slot: MeetingSlot, _ point: MeetingPoint?) -> some View {
        HStack(spacing: 12) {
            MeetingPin(slot: slot, empty: point == nil)
            Text(point?.name ?? "Not chosen")
                .foregroundStyle(point == nil ? Color.ctInkMuted : Color.ctInk)
            Spacer(minLength: 0)
        }
        .frame(minHeight: 48)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(slot == .primary ? "Primary" : "Backup"): \(point?.name ?? "Not chosen")")
    }
}

/// A family member: initials, name, when they last updated, and their status in words.
struct FamilyMemberRow: View {
    let member: FamilyMember

    var body: some View {
        HStack(spacing: 12) {
            PlanAvatar(name: member.name, tint: member.memberStatus.planTone)
            VStack(alignment: .leading, spacing: 2) {
                Text(member.isMe ? "\(member.name) (you)" : member.name)
                    .foregroundStyle(Color.ctInk)
                if member.memberStatus != .unknown, let date = ServerDate.parse(member.statusUpdatedAt) {
                    Text(date, format: .relative(presentation: .named))
                        .font(.caption)
                        .foregroundStyle(Color.ctInkMuted)
                        .monospacedDigit()
                }
            }
            Spacer(minLength: 8)
            MemberStatusTag(status: member.memberStatus)
        }
        .frame(minHeight: 52)
        .accessibilityElement(children: .combine)
    }
}

/// A labeled text field on a sunken surface, in the web kit's input style.
private struct FamilyField: View {
    let title: String
    @Binding var text: String
    let prompt: String
    var monospaced = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color.ctInkMuted)
            TextField(title, text: $text, prompt: Text(prompt).foregroundStyle(Color.ctInkSubtle))
                .accessibilityLabel(title)
                .font(monospaced ? .body.monospaced() : .body)
                .foregroundStyle(Color.ctInk)
                .padding(.horizontal, 12)
                .frame(minHeight: 44)
                .background(Color.ctSurfaceSunken, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Color.ctBorder, lineWidth: 1))
        }
    }
}
