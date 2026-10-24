import SwiftUI
import UIKit

/// The phone's palette (design spec, "Tokens"). Everything else is system UI: grouped
/// backgrounds, `.primary` / `.secondary` text and Liquid Glass controls. Status color appears
/// only as the Slab, an SF Symbol or a map line, and always pairs with words.
extension Color {
    /// Fire edge and fill.
    static let ctFire = Color(light: 0xE4570F, dark: 0xFF7A33)
    /// The way out: route core and destination disc.
    static let ctRoute = Color(light: 0x0A64F0, dark: 0x3D9BFF)
    /// Casing under the route and block lines so they read over any tile.
    static let ctCasing = Color(light: 0xFFFFFF, dark: 0x000000, darkAlpha: 0.6)
    /// Confirmed blocks only: the Leave now red.
    static let ctHazard = Color(light: 0xD7261E, dark: 0xFF5147)

    init(light: UInt32, dark: UInt32, lightAlpha: CGFloat = 1, darkAlpha: CGFloat = 1) {
        self.init(uiColor: UIColor { traits in
            let isDark = traits.userInterfaceStyle == .dark
            let hex = isDark ? dark : light
            return UIColor(
                red: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: isDark ? darkAlpha : lightAlpha)
        })
    }
}

/// Level tokens and words. The contract has no all-clear level.
extension GuidanceLevel {
    /// The Slab fill; `none` has no Slab.
    var fill: Color? {
        switch self {
        case .evacuateNow: return Color(light: 0xD7261E, dark: 0xFF5147)
        case .beReady: return Color(light: 0xF5A623, dark: 0xFFB938)
        case .none: return nil
        }
    }

    /// Text on the Slab.
    var onFill: Color {
        switch self {
        case .evacuateNow: return Color(light: 0xFFFFFF, dark: 0x1A0503)
        case .beReady, .none: return Color(light: 0x1F1300, dark: 0x1F1300)
        }
    }

    /// The level glyph on a system background or glass.
    var glyph: Color {
        switch self {
        case .evacuateNow: return Color(light: 0xD7261E, dark: 0xFF5147)
        case .beReady: return Color(light: 0x8F5300, dark: 0xFFB938)
        case .none: return Color(light: 0x6E7370, dark: 0x9DA29F)
        }
    }

    var symbol: String {
        switch self {
        case .evacuateNow: return "exclamationmark.triangle.fill"
        case .beReady: return "clock.fill"
        case .none: return "circle.dashed"
        }
    }

    /// "Leave now", "Be ready to leave", "No order for {zone}".
    func verdict(zone: String?) -> String {
        switch self {
        case .evacuateNow: return "Leave now"
        case .beReady: return "Be ready to leave"
        case .none: return zone.map { "No order for \($0)" } ?? "No order"
        }
    }
}

/// Type roles (design spec, "Type").
extension Font {
    /// The Slab verdict.
    static let ctVerdict = Font.largeTitle.weight(.black).width(.expanded)
    /// The accessory verdict.
    static let ctVerdictCompact = Font.headline.weight(.bold).width(.expanded)
    /// Labels on the map.
    static let ctMapLabel = Font.caption.weight(.semibold).width(.condensed)
}

extension ReportKind {
    /// The kind's symbol color: fire orange and block red keep their map meaning; the rest are quiet.
    var symbolColor: Color {
        switch self {
        case .fireSeen: return .ctFire
        case .roadBlocked: return .ctHazard
        default: return .secondary
        }
    }
}
