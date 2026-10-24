import MapKit
import SwiftUI

extension ReportKind {
    /// The kind to report when someone confirms the item is still there.
    var stillThereKind: ReportKind { self }

    /// The kind to report when the item is gone. Road kinds flip; others have no direct opposite.
    var goneKind: ReportKind? {
        switch self {
        case .roadBlocked, .heavyTraffic: return .roadPassable
        case .roadPassable: return .roadBlocked
        default: return nil
        }
    }
}

extension LonLat {
    var clCoordinate: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: lat, longitude: lon) }
}

/// Shared map constants for the incident map and the report sheet.
enum LiveMap {
    /// The Paradise-area map region, CA; the starting region before anything is framed.
    static let campRegion = MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: 39.76, longitude: -121.60),
        latitudinalMeters: 6_000, longitudinalMeters: 6_000)
}
