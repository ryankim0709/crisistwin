import CoreLocation
import Observation

enum LocationError: LocalizedError {
    case denied
    case unavailable

    var errorDescription: String? {
        switch self {
        case .denied: return "Location is off for CrisisTwin. Drop a pin on the map instead, or allow location in Settings."
        case .unavailable: return "Your location could not be found. Drop a pin on the map instead."
        }
    }
}

/// When In Use location for reports, the on-device zone and opt-in responder sharing (ADR 0011,
/// 0012). Never Always, never background. One-shot fixes via `currentLocation()`, or continuous
/// foreground updates between `startUpdating()` and `stopUpdating()` while the incident screen is
/// visible. The position stays on the device; `LiveStore` decides what leaves it.
@MainActor
@Observable
final class LocationProvider {
    private(set) var authorization: CLAuthorizationStatus = .notDetermined
    /// Latest valid fix from continuous updates or a one-shot request; nil before the first fix.
    private(set) var lastLocation: CLLocation?

    var isAuthorized: Bool {
        authorization == .authorizedWhenInUse || authorization == .authorizedAlways
    }

    /// How long to wait for a fix before giving up and letting the user drop a pin.
    private static let fixTimeout: Duration = .seconds(10)

    @ObservationIgnored private var updating = false
    @ObservationIgnored private let manager = CLLocationManager()
    @ObservationIgnored private let relay = Relay()
    @ObservationIgnored private var fixWaiters: [UUID: CheckedContinuation<CLLocation, Error>] = [:]
    @ObservationIgnored private var authWaiters: [CheckedContinuation<Void, Never>] = []

    init() {
        relay.owner = self
        manager.delegate = relay
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        manager.pausesLocationUpdatesAutomatically = true
        authorization = manager.authorizationStatus
    }

    /// Shows the When In Use prompt if it has not been answered.
    func requestPermission() {
        guard manager.authorizationStatus == .notDetermined else { return }
        manager.requestWhenInUseAuthorization()
    }

    /// Starts continuous When In Use updates (requesting permission if needed) that refresh
    /// `lastLocation`. Call when the incident screen appears and the app is in the foreground.
    func startUpdating() {
        updating = true
        authorization = manager.authorizationStatus
        if authorization == .notDetermined {
            manager.requestWhenInUseAuthorization()  // updates start once the user answers
            return
        }
        if isAuthorized { manager.startUpdatingLocation() }
    }

    /// Stops continuous updates. Call when the screen disappears or the app leaves the foreground.
    func stopUpdating() {
        updating = false
        manager.stopUpdatingLocation()
    }

    /// One fix, requesting permission first if needed.
    func currentLocation() async throws -> CLLocation {
        authorization = manager.authorizationStatus
        if authorization == .notDetermined {
            // The system prompt has no time limit; the 10 s bound starts once access is granted.
            await withCheckedContinuation { authWaiters.append($0) }
        }
        guard isAuthorized else { throw LocationError.denied }
        guard CLLocationManager.locationServicesEnabled() else { throw LocationError.unavailable }
        // While continuous updates run, the latest fix is current; a one-shot request issued
        // alongside them may never be answered.
        if updating, let last = lastLocation { return last }

        let id = UUID()
        let timeout = Task { [weak self] in
            try await Task.sleep(for: Self.fixTimeout)
            self?.finishFix(id, with: .failure(LocationError.unavailable))
        }
        defer { timeout.cancel() }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                fixWaiters[id] = continuation
                manager.requestLocation()
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.finishFix(id, with: .failure(CancellationError()))
            }
        }
    }

    private func finishFix(_ id: UUID, with result: Result<CLLocation, Error>) {
        fixWaiters.removeValue(forKey: id)?.resume(with: result)
    }

    private func finishAll(_ result: Result<CLLocation, Error>) {
        let waiters = fixWaiters
        fixWaiters = [:]
        for continuation in waiters.values { continuation.resume(with: result) }
    }

    private func authorizationChanged(_ status: CLAuthorizationStatus) {
        authorization = status
        if updating, isAuthorized { manager.startUpdatingLocation() }
        guard status != .notDetermined else { return }
        let waiters = authWaiters
        authWaiters = []
        for continuation in waiters { continuation.resume() }
    }

    private func received(_ locations: [CLLocation]) {
        // A negative horizontal accuracy means the fix is invalid.
        guard let fix = locations.last(where: { $0.horizontalAccuracy >= 0 }) else {
            if updating { return }
            finishAll(.failure(LocationError.unavailable))
            return
        }
        lastLocation = fix
        finishAll(.success(fix))
    }

    private func failed(denied: Bool) {
        finishAll(.failure(denied ? LocationError.denied : LocationError.unavailable))
    }

    /// CLLocationManager needs an NSObject delegate; this forwards its callbacks to the provider.
    private final class Relay: NSObject, CLLocationManagerDelegate, @unchecked Sendable {
        weak var owner: LocationProvider?

        func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
            let status = manager.authorizationStatus
            Task { @MainActor in self.owner?.authorizationChanged(status) }
        }

        func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
            Task { @MainActor in self.owner?.received(locations) }
        }

        func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
            let denied = (error as? CLError)?.code == .denied
            Task { @MainActor in self.owner?.failed(denied: denied) }
        }
    }
}
