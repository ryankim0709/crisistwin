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

/// The household meeting plan on its own page (opened from Home and Family): where to meet if
/// separated, and who to tell. The same cards as the Plan tab.
struct PlanView: View {
    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                MeetingPointCard()
                TrustedContactsCard()
            }
            .ctScreenPadding()
        }
        .ctScreenBackground()
        .navigationTitle("Meeting points")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Presents the system contact picker. It needs no Contacts permission: iOS returns only the chosen person.
/// It must be presented from a view controller rather than embedded in a sheet.
struct ContactPicker: UIViewControllerRepresentable {
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
struct MessageComposer: UIViewControllerRepresentable {
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
