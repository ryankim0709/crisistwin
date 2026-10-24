import Observation
import SwiftUI

/// One thing to pack in the household go-bag.
struct GoBagItem: Identifiable, Equatable {
    var id: String
    var title: String
    var systemImage: String
}

/// The household go-bag checklist, kept only on this phone (UserDefaults).
@MainActor
@Observable
final class GoBagStore {
    static let items: [GoBagItem] = [
        GoBagItem(id: "water", title: "Water for 3 days", systemImage: "drop"),
        GoBagItem(id: "food", title: "Food for 3 days", systemImage: "takeoutbag.and.cup.and.straw"),
        GoBagItem(id: "medications", title: "Medications", systemImage: "pills"),
        GoBagItem(id: "documents", title: "IDs and documents", systemImage: "doc.text"),
        GoBagItem(id: "charger", title: "Phone charger", systemImage: "battery.100.bolt"),
        GoBagItem(id: "cash", title: "Cash", systemImage: "banknote"),
        GoBagItem(id: "flashlight", title: "Flashlight", systemImage: "flashlight.on.fill"),
        GoBagItem(id: "firstaid", title: "First aid kit", systemImage: "cross.case"),
        GoBagItem(id: "masks", title: "N95 masks", systemImage: "facemask"),
    ]

    private static let key = "plan.goBag.packed"

    private(set) var packed: Set<String>

    init() {
        packed = Set(UserDefaults.standard.stringArray(forKey: Self.key) ?? [])
    }

    func toggle(_ item: GoBagItem) {
        if packed.contains(item.id) { packed.remove(item.id) } else { packed.insert(item.id) }
        UserDefaults.standard.set(Array(packed).sorted(), forKey: Self.key)
    }

    /// "6 of 9 packed".
    var summary: String {
        let count = Self.items.filter { packed.contains($0.id) }.count
        return "\(count) of \(Self.items.count) packed"
    }
}

/// The go-bag checklist.
struct GoBagView: View {
    @Environment(GoBagStore.self) private var store
    @State private var tick = 0

    var body: some View {
        List {
            Section {
                ForEach(GoBagStore.items) { item in
                    let isPacked = store.packed.contains(item.id)
                    Button {
                        tick += 1
                        store.toggle(item)
                    } label: {
                        HStack(spacing: 12) {
                            Label(item.title, systemImage: item.systemImage)
                            Spacer()
                            Image(systemName: isPacked ? "checkmark.circle.fill" : "circle")
                                .font(.title3)
                                .foregroundStyle(isPacked ? Color.primary : Color.secondary)
                                .contentTransition(.symbolEffect(.replace))
                                .accessibilityHidden(true)
                        }
                        .frame(minHeight: 44)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityValue(isPacked ? "Packed" : "Not packed")
                    .accessibilityAddTraits(isPacked ? .isSelected : [])
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Go-bag")
        .navigationSubtitle(store.summary)
        .sensoryFeedback(.selection, trigger: tick)
    }
}
