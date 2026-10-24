import Contacts
import ContactsUI
import MapKit
import MessageUI
import SwiftUI

enum PlanMap {
    /// Berkeley, matching the project's Berkeley Hills demo area, until the user picks a point.
    static let defaultRegion = MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: 37.8716, longitude: -122.2727),
        latitudinalMeters: 6_000,
        longitudinalMeters: 6_000
    )
}

private enum PointSlot: String, Identifiable {
    case primary, backup
    var id: String { rawValue }
    var title: String { self == .primary ? "Primary meeting point" : "Backup meeting point" }
}

/// The household meeting plan: where to meet if separated, and who to tell.
struct PlanView: View {
    @Environment(MeetingPlanStore.self) private var store
    @Environment(FamilyStore.self) private var family
    @State private var editing: PointSlot?
    @State private var pickingContact = false
    @State private var composingMessage = false
    @State private var camera: MapCameraPosition = .region(PlanMap.defaultRegion)

    private var plan: MeetingPlan { store.plan }

    var body: some View {
        List {
            if let message = store.errorMessage {
                Section {
                    Label(message, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.secondary)
                }
            }

            Section {
                Map(position: $camera) {
                    if let primary = plan.primary {
                        Marker("1. \(primary.name)", systemImage: "figure.2", coordinate: primary.coordinate)
                            .tint(Color.ctRoute)
                    }
                    if let backup = plan.backup {
                        Marker("2. \(backup.name)", systemImage: "figure.2", coordinate: backup.coordinate)
                            .tint(.gray)
                    }
                }
                .frame(height: 240)
                .overlay(alignment: .bottomLeading) { mapLegend }
                .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
                .accessibilityLabel(mapSummary)
            }

            if let shared = family.family {
                Section {
                    Label("Meeting points are shared with \(shared.name).", systemImage: "person.3")
                        .font(.subheadline)
                }
            }

            pointSection(.primary, point: plan.primary)
            pointSection(.backup, point: plan.backup)

            Section {
                ForEach(plan.contacts) { contact in
                    HStack(spacing: 12) {
                        Image(systemName: "person.crop.circle.fill")
                            .font(.title2)
                            .foregroundStyle(.secondary)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(contact.name)
                            Text(contact.phone ?? "No phone number")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
                .onDelete { offsets in
                    store.update { $0.contacts.remove(atOffsets: offsets) }
                }
                Button {
                    pickingContact = true
                } label: {
                    Label("Add a trusted contact", systemImage: "person.crop.circle.badge.plus")
                        .frame(minHeight: 44)
                }
            } header: {
                Text("Trusted contacts")
            }

            Section {
                sendButton
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Meeting point")
        .sheet(item: $editing) { slot in
            MeetingPointEditor(title: slot.title, point: slot == .primary ? plan.primary : plan.backup) { point in
                store.update { plan in
                    if slot == .primary { plan.primary = point } else { plan.backup = point }
                }
                shareWithFamily()
                fitCamera()
            }
        }
        .sheet(isPresented: $composingMessage) {
            MessageComposer(
                recipients: plan.contacts.compactMap(\.phone),
                body: plan.shareText
            )
            .ignoresSafeArea()
        }
        .onAppear { fitCamera() }
        .background(ContactPicker(isPresented: $pickingContact) { contact in
            store.update { plan in
                if !plan.contacts.contains(where: { $0.id == contact.id }) { plan.contacts.append(contact) }
            }
        })
    }

    /// In a family, meeting points are shared: send the new ones to the server.
    private func shareWithFamily() {
        guard family.isJoined else { return }
        let plan = store.plan
        Task { await family.setMeetingPoints(primary: plan.primary, backup: plan.backup) }
    }

    /// Frame the chosen points, or the demo area when there are none.
    private func fitCamera() {
        let points = [plan.primary, plan.backup].compactMap { $0?.coordinate }
        guard let first = points.first else {
            camera = .region(PlanMap.defaultRegion)
            return
        }
        let latitudes = points.map(\.latitude), longitudes = points.map(\.longitude)
        let center = CLLocationCoordinate2D(
            latitude: (latitudes.min()! + latitudes.max()!) / 2,
            longitude: (longitudes.min()! + longitudes.max()!) / 2
        )
        // Pad around both points, but never zoom in past street level around a single point.
        let span = MKCoordinateSpan(
            latitudeDelta: max((latitudes.max()! - latitudes.min()!) * 1.6, 0.015),
            longitudeDelta: max((longitudes.max()! - longitudes.min()!) * 1.6, 0.015)
        )
        camera = .region(MKCoordinateRegion(center: points.count == 1 ? first : center, span: span))
    }

    private var mapSummary: String {
        switch (plan.primary, plan.backup) {
        case (nil, _): return "Map. No meeting point chosen yet."
        case (let primary?, nil): return "Map showing primary meeting point \(primary.name)."
        case (let primary?, let backup?): return "Map showing primary \(primary.name) and backup \(backup.name)."
        }
    }

    /// Names each pin color in text, so the map never relies on color alone.
    private var mapLegend: some View {
        HStack(spacing: 6) {
            if plan.primary != nil { LegendChip(number: 1, text: "Primary", tint: .ctRoute) }
            if plan.backup != nil { LegendChip(number: 2, text: "Backup", tint: .gray) }
        }
        .padding(10)
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func pointSection(_ slot: PointSlot, point: MeetingPoint?) -> some View {
        Section {
            if let point {
                HStack(alignment: .top, spacing: 12) {
                    SlotBadge(number: slot == .primary ? 1 : 2, tint: slot == .primary ? .ctRoute : .gray)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(point.name)
                            .font(.headline)
                        if !point.note.isEmpty {
                            Text(point.note)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(.vertical, 4)
                .accessibilityElement(children: .combine)
                Link(destination: point.directionsURL) {
                    Label("Open in Maps", systemImage: "arrow.triangle.turn.up.right.diamond")
                        .frame(minHeight: 44)
                }
                Button {
                    editing = slot
                } label: {
                    Label("Change", systemImage: "pencil")
                        .frame(minHeight: 44)
                }
                Button(role: .destructive) {
                    store.update { plan in
                        // Without a primary, the backup moves up rather than standing alone.
                        if slot == .primary { plan.primary = plan.backup; plan.backup = nil } else { plan.backup = nil }
                    }
                    shareWithFamily()
                    fitCamera()
                } label: {
                    Label("Remove", systemImage: "trash")
                        .frame(minHeight: 44)
                }
            } else {
                Button {
                    editing = slot
                } label: {
                    HStack(spacing: 12) {
                        SlotBadge(number: slot == .primary ? 1 : 2, tint: slot == .primary ? .ctRoute : .gray)
                        Text(slot == .primary ? "Choose where to meet" : "Add a backup")
                            .font(.body.weight(.medium))
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                        Image(systemName: "plus.circle.fill")
                            .font(.title3)
                            .accessibilityHidden(true)
                    }
                    .frame(minHeight: 44)
                }
                .disabled(slot == .backup && plan.primary == nil)
            }
        } header: {
            Text(slot.title)
        }
    }

    @ViewBuilder
    private var sendButton: some View {
        let hasPhones = plan.contacts.contains { $0.phone != nil }
        if plan.primary == nil {
            Label("Choose a meeting point to share your plan", systemImage: "square.and.arrow.up")
                .foregroundStyle(.secondary)
        } else if hasPhones && MFMessageComposeViewController.canSendText() {
            Button {
                composingMessage = true
            } label: {
                Label("Text plan to trusted contacts", systemImage: "message")
            }
        } else {
            // Simulators and devices without Messages fall back to the share sheet.
            ShareLink(item: plan.shareText) {
                Label("Share plan", systemImage: "square.and.arrow.up")
            }
        }
    }
}

/// A numbered circle that matches the map pin of the same slot.
private struct SlotBadge: View {
    let number: Int
    let tint: Color

    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 30

    var body: some View {
        Text("\(number)")
            .font(.subheadline.weight(.bold))
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .background(tint.opacity(0.14), in: Circle())
            .accessibilityHidden(true)
    }
}

private struct LegendChip: View {
    let number: Int
    let text: String
    let tint: Color

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(tint).frame(width: 8, height: 8)
            Text("\(number). \(text)")
        }
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .glassEffect(.regular, in: .capsule)
    }
}

/// Presents the system contact picker. It needs no Contacts permission: iOS returns only the chosen person.
/// It must be presented from a view controller rather than embedded in a sheet.
private struct ContactPicker: UIViewControllerRepresentable {
    @Binding var isPresented: Bool
    let onPick: (TrustedContact) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIViewController(context: Context) -> UIViewController { UIViewController() }

    func updateUIViewController(_ host: UIViewController, context: Context) {
        context.coordinator.parent = self
        guard isPresented, host.presentedViewController == nil else { return }
        let picker = CNContactPickerViewController()
        picker.delegate = context.coordinator
        picker.displayedPropertyKeys = [CNContactPhoneNumbersKey]
        DispatchQueue.main.async { host.present(picker, animated: true) }
    }

    final class Coordinator: NSObject, CNContactPickerDelegate {
        var parent: ContactPicker
        init(_ parent: ContactPicker) { self.parent = parent }

        func contactPicker(_ picker: CNContactPickerViewController, didSelect contact: CNContact) {
            let name = CNContactFormatter.string(from: contact, style: .fullName) ?? "Unnamed contact"
            parent.onPick(TrustedContact(
                id: contact.identifier,
                name: name,
                phone: contact.phoneNumbers.first?.value.stringValue
            ))
            parent.isPresented = false
        }

        func contactPickerDidCancel(_ picker: CNContactPickerViewController) {
            parent.isPresented = false
        }
    }
}

/// Opens Messages with the plan filled in. The user reviews and sends it; nothing is sent automatically.
private struct MessageComposer: UIViewControllerRepresentable {
    let recipients: [String]
    let body: String
    @Environment(\.dismiss) private var dismiss

    func makeCoordinator() -> Coordinator { Coordinator(dismiss: dismiss) }

    func makeUIViewController(context: Context) -> MFMessageComposeViewController {
        let composer = MFMessageComposeViewController()
        composer.recipients = recipients
        composer.body = body
        composer.messageComposeDelegate = context.coordinator
        return composer
    }

    func updateUIViewController(_ composer: MFMessageComposeViewController, context: Context) {}

    final class Coordinator: NSObject, MFMessageComposeViewControllerDelegate {
        let dismiss: DismissAction
        init(dismiss: DismissAction) { self.dismiss = dismiss }

        func messageComposeViewController(_ controller: MFMessageComposeViewController, didFinishWith result: MessageComposeResult) {
            dismiss()
        }
    }
}
