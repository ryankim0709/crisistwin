import Foundation

/// Finds the device's zone on the device (ADR 0012): the position is never sent to find it.
enum ZoneLocator {
    /// The first zone whose geometry contains `point` (even-odd rule, holes excluded), or nil.
    /// Coordinates are WGS84 `[lon, lat]`; zones are small enough for planar tests.
    static func zone(containing point: LonLat, in zones: [LiveZone]) -> LiveZone? {
        zones.first { zone in
            zone.geometry.polygons.contains { rings in
                // Even-odd across all rings of a polygon: a point in a hole crosses two rings.
                rings.reduce(false) { inside, ring in contains(ring, point) != inside }
            }
        }
    }

    private static func contains(_ ring: [LonLat], _ p: LonLat) -> Bool {
        guard ring.count >= 3 else { return false }
        var inside = false
        var j = ring.count - 1
        for i in 0..<ring.count {
            let a = ring[i], b = ring[j]
            if (a.lat > p.lat) != (b.lat > p.lat),
               p.lon < (b.lon - a.lon) * (p.lat - a.lat) / (b.lat - a.lat) + a.lon {
                inside.toggle()
            }
            j = i
        }
        return inside
    }
}
