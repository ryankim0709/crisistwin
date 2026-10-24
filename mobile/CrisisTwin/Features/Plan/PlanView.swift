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
                }
            }

            Section {
                Map(position: $camera) {
                    if let primary = plan.primary {
                        Marker("1 · \(primary.name)", systemImage: "figure.2", coordinate: primary.coordinate)
                            .tint(Color.accentColor)
                    }
                    if let backup = plan.backup {
                        Marker("2 · \(backup.name)", systemImage: "figure.2", coordinate: backup.coordinate)
                            .tint(.orange)
                    }
                }
                .frame(height: 240)
                .listRowInsets(EdgeInsets())
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
                    VStack(alignment: .leading) {
                        Text(contact.name)
                        Text(contact.phone ?? "No phone number")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .onDelete { offsets in
                    store.update { $0.contacts.remove(atOffsets: offsets) }
                }
                Button {
                    pickingContact = true
                } label: {
                    Label("Add a trusted contact", systemImage: "person.crop.circle.badge.plus")
                }
            } header: {
                Text("Trusted contacts")
            } footer: {
                Text("Only the name and phone number you pick are saved, on this phone.")
            }

            Section {
                sendButton
            } footer: {
                Text("Your personal plan, not an official shelter or instruction. Follow evacuation orders from local authorities first.")
            }
        }
        .background(Color("WorkspaceBackground"))
        .scrollContentBackground(.hidden)
        .navigationTitle("My Plan")
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

    @ViewBuilder
    private func pointSection(_ slot: PointSlot, point: MeetingPoint?) -> some View {
        Section(slot.title) {
            if let point {
                VStack(alignment: .leading, spacing: 4) {
                    Text(point.name).font(.headline)
                    if !point.note.isEmpty {
                        Text(point.note).foregroundStyle(.secondary)
                    }
                }
                Link(destination: point.directionsURL) {
                    Label("Open in Maps", systemImage: "arrow.triangle.turn.up.right.diamond")
                }
                Button("Change") { editing = slot }
                Button("Remove", role: .destructive) {
                    store.update { plan in
                        // Without a primary, the backup moves up rather than standing alone.
                        if slot == .primary { plan.primary = plan.backup; plan.backup = nil } else { plan.backup = nil }
                    }
                    shareWithFamily()
                    fitCamera()
                }
            } else {
                Button {
                    editing = slot
                } label: {
                    Label(
                        slot == .primary ? "Choose where to meet" : "Add a backup in case the first is unreachable",
                        systemImage: "mappin.and.ellipse"
                    )
                }
                .disabled(slot == .backup && plan.primary == nil)
            }
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
