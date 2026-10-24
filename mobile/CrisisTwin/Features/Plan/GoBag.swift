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

    var packedCount: Int { Self.items.filter { packed.contains($0.id) }.count }

    /// 0...1, for the progress ring.
    var progress: Double { Double(packedCount) / Double(Self.items.count) }

    /// "6 of 9 packed".
    var summary: String { "\(packedCount) of \(Self.items.count) packed" }
}

/// The go-bag on the Plan tab: progress ring and the checklist as tappable tiles.
struct GoBagCard: View {
    @Environment(GoBagStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Go-bag")
                        .font(.ctTitle)
                        .foregroundStyle(Color.ctInk)
                        .accessibilityAddTraits(.isHeader)
                    Text(store.summary)
                        .font(.subheadline)
                        .foregroundStyle(Color.ctInkMuted)
                        .monospacedDigit()
                        .contentTransition(.numericText())
                }
                Spacer(minLength: 8)
                GoBagRing(progress: store.progress, count: store.packedCount, total: GoBagStore.items.count)
            }
            GoBagGrid()
        }
        .ctPanel()
    }
}

/// Packed share of the go-bag as a ring, with the count inside; a check when it is all packed.
struct GoBagRing: View {
    let progress: Double
    let count: Int
    let total: Int
    var lineWidth: CGFloat = 6
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 56

    var body: some View {
        let done = count == total
        ZStack {
            Circle().stroke(Color.ctBrandSoft, lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: progress)
                .stroke(done ? Color.ctSuccess : Color.ctBrand,
                        style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .opacity(count == 0 ? 0 : 1)
            if done {
                Image(systemName: "checkmark")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(Color.ctSuccess)
                    .transition(.scale.combined(with: .opacity))
            } else {
                Text("\(count)/\(total)")
                    .font(.footnote.weight(.semibold).monospacedDigit())
                    .foregroundStyle(Color.ctInk)
                    .contentTransition(.numericText())
            }
        }
        .frame(width: size, height: size)
        .animation(.snappy, value: progress)
        .accessibilityElement()
        .accessibilityLabel("Go-bag")
        .accessibilityValue("\(count) of \(total) packed")
    }
}

/// The checklist as a two-column grid of tiles; tapping one packs or unpacks it.
struct GoBagGrid: View {
    @Environment(GoBagStore.self) private var store
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var tick = 0

    var body: some View {
        let columns = Array(repeating: GridItem(.flexible(), spacing: 8, alignment: .top),
                            count: typeSize.isAccessibilitySize ? 1 : 2)
        LazyVGrid(columns: columns, spacing: 8) {
            ForEach(GoBagStore.items) { item in
                tile(item, packed: store.packed.contains(item.id))
            }
        }
        .sensoryFeedback(.selection, trigger: tick)
    }

    private func tile(_ item: GoBagItem, packed: Bool) -> some View {
        Button {
            tick += 1
            withAnimation(.snappy) { store.toggle(item) }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: packed ? "checkmark.circle.fill" : item.systemImage)
                    .font(.body.weight(.medium))
                    .foregroundStyle(packed ? Color.ctBrand : Color.ctInkMuted)
                    .frame(width: 24)
                    .contentTransition(.symbolEffect(.replace))
                    .accessibilityHidden(true)
                Text(item.title)
                    .font(.subheadline)
                    .foregroundStyle(packed ? Color.ctBrandStrong : Color.ctInk)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            .background(packed ? Color.ctBrandSoft : Color.ctSurfaceSunken,
                        in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(packed ? Color.ctBrand.opacity(0.35) : Color.ctBorderSubtle, lineWidth: 1))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(item.title)
        .accessibilityValue(packed ? "Packed" : "Not packed")
        .accessibilityAddTraits(packed ? .isSelected : [])
    }
}

/// The go-bag on its own page (opened from Home).
struct GoBagView: View {
    var body: some View {
        ScrollView {
            GoBagCard()
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
        }
        .ctScreenBackground()
        .navigationTitle("Go-bag")
        .navigationBarTitleDisplayMode(.inline)
    }
}
