import SwiftUI
import UIKit

/// The phone's palette. Light mode is the resident app's own "mint and cream": a pastel mint
/// page with warm cream cards and deep green actions. Dark mode stays the web UI kit's
/// "operations console" (`app/src/ui/tokens.css`). Hazard colors keep the same meaning as on the web maps. Status color
/// always pairs with words or a symbol.
extension Color {
    // Ink (`--ct-ink*`).
    static let ctInk = Color(light: 0x142B27, dark: 0xE6EDF3)
    static let ctInkMuted = Color(light: 0x52635C, dark: 0x8B9AA8)
    static let ctInkSubtle = Color(light: 0x6A7166, dark: 0x6B7A88)

    // Surfaces (`--ct-bg`, `--ct-surface*`).
    static let ctBackground = Color(light: 0xEAF4EC, dark: 0x070A0E)
    static let ctSurface = Color(light: 0xFFFDF8, dark: 0x0C1117)
    static let ctSurfaceRaised = Color(light: 0xFFFFFF, dark: 0x121922)
    static let ctSurfaceSunken = Color(light: 0xF2F8F3, dark: 0x080C11)
    static let ctSurfaceMuted = Color(light: 0xDCEFE2, dark: 0x10161D)

    // Borders (`--ct-border*`).
    static let ctBorder = Color(light: 0xD3E3D7, dark: 0xA0BEDC, darkAlpha: 0.14)
    static let ctBorderSubtle = Color(light: 0xE3EEE6, dark: 0xA0BEDC, darkAlpha: 0.08)

    // Brand (`--ct-brand*`): primary actions and selection.
    static let ctBrand = Color(light: 0x2F6B5A, dark: 0x3DDBB4)
    static let ctBrandStrong = Color(light: 0x142B27, dark: 0x7CF2C9)
    static let ctBrandSoft = Color(light: 0xDCEFE2, dark: 0x3DDBB4, darkAlpha: 0.12)

    // Status (`--ct-success|warning|danger|info` and `-soft`).
    static let ctSuccess = Color(light: 0x215B45, dark: 0x7CF2C9)
    static let ctSuccessSoft = Color(light: 0xDCEFE2, dark: 0x7CF2C9, darkAlpha: 0.10)
    static let ctWarning = Color(light: 0x795A20, dark: 0xFFB547)
    static let ctWarningSoft = Color(light: 0xF5ECD8, dark: 0xFFB547, darkAlpha: 0.10)
    static let ctDanger = Color(light: 0xB3261E, dark: 0xFF4D6D)
    static let ctDangerSoft = Color(light: 0xFCEBEA, dark: 0xFF4D6D, darkAlpha: 0.10)
    static let ctInfo = Color(light: 0x1D5F8A, dark: 0x9FC6EC)
    static let ctInfoSoft = Color(light: 0xE6F0F6, dark: 0x9FC6EC, darkAlpha: 0.10)

    // Hazard data (`--ct-fire`, `--ct-route`, `--ct-closure`, `--ct-shelter`, `--ct-smoke`).
    /// Fire estimate edge and fill.
    static let ctFire = Color(light: 0xEE6B4D, dark: 0xFF6A1A)
    /// The way out: route core and destination marker.
    static let ctRoute = Color(light: 0x3B82C4, dark: 0x5AA2E0)
    /// Casing under the route and block lines so they read over any tile.
    static let ctCasing = Color(light: 0xFFFFFF, dark: 0x000000, darkAlpha: 0.6)
    /// Confirmed road closures only.
    static let ctHazard = Color(light: 0xDC2626, dark: 0xFF4D6D)
    static let ctShelter = Color(light: 0x22C55E, dark: 0x22C55E)
    static let ctSmoke = Color(light: 0x8B9AA8, dark: 0x8B9AA8)

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

/// Level tokens and words, from the web status tones. The contract has no all-clear level.
extension GuidanceLevel {
    /// The Slab fill; `none` has no Slab.
    var fill: Color? {
        switch self {
        case .evacuateNow: return .ctDanger
        case .beReady: return Color(light: 0xF2A33A, dark: 0xFFB547)
        case .none: return nil
        }
    }

    /// Text on the Slab.
    var onFill: Color {
        switch self {
        case .evacuateNow: return Color(light: 0xFFFFFF, dark: 0x070A0E)
        case .beReady, .none: return Color(light: 0x142B27, dark: 0x070A0E)
        }
    }

    /// The level glyph or text on a surface or glass.
    var glyph: Color {
        switch self {
        case .evacuateNow: return .ctDanger
        case .beReady: return .ctWarning
        case .none: return .ctInkMuted
        }
    }

    /// A soft background for the level (zone fills on the map, tinted rows).
    var soft: Color {
        switch self {
        case .evacuateNow: return .ctDangerSoft
        case .beReady: return .ctWarningSoft
        case .none: return .ctSurfaceMuted
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

/// Type roles, following the web scale (`--ct-text-*`, Inter on the web, SF Pro here) at
/// standard width: no expanded or condensed faces.
extension Font {
    /// The Slab verdict.
    static let ctVerdict = Font.system(.title, weight: .bold)
    /// The accessory and compact verdicts.
    static let ctVerdictCompact = Font.system(.subheadline, weight: .semibold)
    /// Section and card titles.
    static let ctTitle = Font.system(.headline, weight: .semibold)
    /// Big numbers: ETA, distance, counts (`--ct-text-metric`).
    static let ctMetric = Font.system(size: 29, weight: .semibold).monospacedDigit()
    /// Labels on the map.
    static let ctMapLabel = Font.system(.caption, weight: .semibold)
}

/// Spacing follows the web kit's 4 pt scale (`--ct-space-*`), by role:
/// - 2: a line and its detail line; 4: a label and its control.
/// - 8: buttons or chips in a row; a section title above a panel.
/// - 12: rows in a panel, a panel's title to its content, an icon column to its text.
/// - 16: panel padding, screen margins, and the gap between panels.
/// - 24: between titled sections, and the end of a scrolling screen.

/// The web kit's Panel: surface, 12 pt radius, 1 pt border. Use for content cards on the
/// Home, Reports and Plan screens; floating controls over the map use Liquid Glass instead.
struct CTPanel: ViewModifier {
    var padding: CGFloat = 16

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.ctSurface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.ctBorder, lineWidth: 1))
    }
}

extension View {
    func ctPanel(padding: CGFloat = 16) -> some View { modifier(CTPanel(padding: padding)) }

    /// The margins of a scrolling screen of panels: 16 at the sides, 8 on top, 24 at the end.
    func ctScreenPadding() -> some View {
        padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 24)
    }

    /// The screen background behind panels (`--ct-bg`).
    func ctScreenBackground() -> some View {
        background(Color.ctBackground.ignoresSafeArea())
    }
}

extension ReportKind {
    /// The kind's symbol color: fire orange and block red keep their map meaning; the rest are quiet.
    var symbolColor: Color {
        switch self {
        case .fireSeen: return .ctFire
        case .roadBlocked: return .ctHazard
        default: return .ctInkMuted
        }
    }
}

/// The CrisisTwin lockup (`Logo` asset, from `app/public/brand`). It is drawn in deep green for
/// light backgrounds, so dark mode renders it as a light single-color mark.
struct CTBrandLogo: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Group {
            if colorScheme == .dark {
                Image("Logo").resizable().renderingMode(.template).foregroundStyle(Color.ctInk)
            } else {
                Image("Logo").resizable()
            }
        }
        .aspectRatio(contentMode: .fit)
        .accessibilityLabel("CrisisTwin")
    }
}

/// The top of every main screen (Home, Reports, Plan): the logo with the page name right under it,
/// so no empty navigation bar sits above the title. `accessory` sits beside the name (the
/// Exercise tag).
struct CTPageHeader<Accessory: View>: View {
    let title: String
    @ViewBuilder var accessory: Accessory

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            CTBrandLogo()
                .frame(height: 30)
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(title)
                    .font(.system(.title, design: .rounded, weight: .bold))
                    .foregroundStyle(Color.ctInk)
                    .accessibilityAddTraits(.isHeader)
                accessory
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 8)
    }
}

extension CTPageHeader where Accessory == EmptyView {
    init(title: String) {
        self.init(title: title) { EmptyView() }
    }
}

extension View {
    /// A main screen that draws its own `CTPageHeader`: the navigation bar is hidden, and the
    /// status bar gets the screen color so scrolled content does not run under it. Screens pushed
    /// from it keep their own bar and back button.
    func ctOwnHeader() -> some View {
        toolbar(.hidden, for: .navigationBar)
            .overlay(alignment: .top) {
                Color.ctBackground
                    .frame(height: 0)
                    .background(Color.ctBackground.ignoresSafeArea(edges: .top))
            }
    }
}
