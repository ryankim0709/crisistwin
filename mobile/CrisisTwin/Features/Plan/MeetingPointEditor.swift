import MapKit
import SwiftUI

/// Pick a meeting point by searching Apple Maps or tapping the map, then name it.
struct MeetingPointEditor: View {
    let title: String
    let onSave: (MeetingPoint) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var note: String
    @State private var coordinate: CLLocationCoordinate2D?
    @State private var camera: MapCameraPosition
    @State private var visibleRegion: MKCoordinateRegion?
    @State private var query = ""
    @State private var results: [MKMapItem] = []
    @State private var searchMessage: String?

    init(title: String, point: MeetingPoint?, onSave: @escaping (MeetingPoint) -> Void) {
        self.title = title
        self.onSave = onSave
        _name = State(initialValue: point?.name ?? "")
        _note = State(initialValue: point?.note ?? "")
        let coordinate = point.map { CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude) }
        _coordinate = State(initialValue: coordinate)
        _camera = State(initialValue: coordinate.map {
            .region(MKCoordinateRegion(center: $0, latitudinalMeters: 1_500, longitudinalMeters: 1_500))
        } ?? .region(PlanMap.defaultRegion))
    }

    private var draft: MeetingPoint? {
        guard let coordinate else { return nil }
        let point = MeetingPoint(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            note: note.trimmingCharacters(in: .whitespacesAndNewlines),
            latitude: coordinate.latitude,
            longitude: coordinate.longitude
        )
        return point.isValid ? point : nil
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label {
                        TextField("Search places, e.g. a park or school", text: $query)
                            .textInputAutocapitalization(.words)
                            .submitLabel(.search)
                    } icon: {
                        Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    }
                }

                Section {
                    MapReader { proxy in
                        Map(position: $camera) {
                            if let coordinate {
                                Marker(name.isEmpty ? "Meeting point" : name, systemImage: "figure.2", coordinate: coordinate)
                            }
                        }
                        .onMapCameraChange { visibleRegion = $0.region }
                        .onTapGesture { location in
                            if let tapped = proxy.convert(location, from: .local) { coordinate = tapped }
                        }
                    }
                    .frame(height: 260)
                    .listRowInsets(EdgeInsets())
                    .accessibilityLabel("Map. Tap to place the meeting point.")
                } footer: {
                    Text(coordinate == nil ? "Search for a place, or tap the map to drop a pin." : "Tap the map to move the pin.")
                }

                if !results.isEmpty || searchMessage != nil {
                    Section("Search results") {
                        if let searchMessage {
                            Text(searchMessage).foregroundStyle(.secondary)
                        }
                        ForEach(results, id: \.self) { item in
                            Button {
                                choose(item)
                            } label: {
                                VStack(alignment: .leading) {
                                    Text(item.name ?? "Unnamed place")
                                    if let address = item.placemark.title {
                                        Text(address).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                }

                Section("Details") {
                    TextField("Name, e.g. Live Oak Park", text: $name)
                    TextField("Note, e.g. by the north entrance", text: $note, axis: .vertical)
                }
            }
            .task(id: query) { await search(query) }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        if let draft {
                            onSave(draft)
                            dismiss()
                        }
                    }
                    .disabled(draft == nil)
                }
            }
        }
    }

    private func choose(_ item: MKMapItem) {
        let picked = item.placemark.coordinate
        coordinate = picked
        if let itemName = item.name, name.isEmpty { name = itemName }
        camera = .region(MKCoordinateRegion(center: picked, latitudinalMeters: 1_500, longitudinalMeters: 1_500))
        results = []
        query = ""
    }

    private func search(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            results = []
            searchMessage = nil
            return
        }
        // Debounce typing; .task(id:) cancels this call when the query changes.
        try? await Task.sleep(for: .milliseconds(350))
        guard !Task.isCancelled else { return }

        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = trimmed
        request.region = visibleRegion ?? PlanMap.defaultRegion
        do {
            let response = try await MKLocalSearch(request: request).start()
            guard !Task.isCancelled else { return }
            results = Array(response.mapItems.prefix(8))
            searchMessage = results.isEmpty ? "No places found." : nil
        } catch {
            guard !Task.isCancelled else { return }
            results = []
            searchMessage = "Search is unavailable. You can still tap the map to drop a pin."
        }
    }
}
