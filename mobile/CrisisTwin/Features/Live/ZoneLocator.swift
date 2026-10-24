import Foundation

/// Finds the device's zone on the device (ADR 0012): the position is never sent to find it.
enum ZoneLocator {
    /// The first zone whose geometry contains `point` (even-odd rule, holes excluded), or nil.
    /// Coordinates are WGS84 `[lon, lat]`; zones are small enough for planar tests.
    static func zone(containing point: LonLat, in zones: [LiveZone]) -> LiveZone? {
        zones.first { contains($0.geometry, point) }
    }

    /// Whether `geometry` contains `point` (even-odd rule, holes excluded).
    static func contains(_ geometry: LiveGeometry, _ point: LonLat) -> Bool {
        geometry.polygons.contains { rings in
            // Even-odd across all rings of a polygon: a point in a hole crosses two rings.
            rings.reduce(false) { inside, ring in contains(ring, point) != inside }
        }
    }

    /// The point on the rings of `geometry` nearest `point`, and its distance in metres (0 when
    /// `point` is inside). Planar in a local equirectangular projection, fine at incident scale.
    static func nearest(on geometry: LiveGeometry, to point: LonLat) -> (coord: LonLat, meters: Double)? {
        let mPerLat = 111_320.0, mPerLon = 111_320.0 * cos(point.lat * .pi / 180)
        func xy(_ c: LonLat) -> (Double, Double) { ((c.lon - point.lon) * mPerLon, (c.lat - point.lat) * mPerLat) }
        var best: (coord: LonLat, meters: Double)?
        for ring in geometry.polygons.flatMap({ $0 }) where ring.count > 1 {
            for i in 0..<(ring.count - 1) {
                let a = xy(ring[i]), b = xy(ring[i + 1])
                let dx = b.0 - a.0, dy = b.1 - a.1
                let len2 = dx * dx + dy * dy
                let t = len2 > 0 ? max(0, min(1, -(a.0 * dx + a.1 * dy) / len2)) : 0
                let px = a.0 + t * dx, py = a.1 + t * dy
                let d = (px * px + py * py).squareRoot()
                if best == nil || d < best!.meters {
                    best = (LonLat(lon: point.lon + px / mPerLon, lat: point.lat + py / mPerLat), d)
                }
            }
        }
        guard let found = best else { return nil }
        return contains(geometry, point) ? (point, 0) : found
    }

    /// Eight-way compass word from `from` to `to`: "north", "north-east", ...
    static func compassWord(from: LonLat, to: LonLat) -> String {
        let dx = (to.lon - from.lon) * cos(from.lat * .pi / 180), dy = to.lat - from.lat
        let degrees = (atan2(dx, dy) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360)
        let words = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"]
        return words[Int((degrees + 22.5) / 45) % 8]
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
