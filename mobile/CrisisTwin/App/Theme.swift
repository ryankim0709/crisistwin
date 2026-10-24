import SwiftUI
import UIKit

/// Shared visual language, matching the web workspace's cream and deep-green palette
/// (`app/src/index.css`). Color never carries meaning alone: pair tones with text and an icon.
extension Color {
    /// Primary text: deep green-black on cream, soft off-white in dark mode.
    static let ctInk = Color(light: 0x142B27, dark: 0xE8EEEA)
    /// Secondary text.
    static let ctMuted = Color(light: 0x52635C, dark: 0x9FB2A9)
    /// Raised surfaces such as cards and sheets.
    static let ctSurface = Color(light: 0xFCFCF8, dark: 0x16211D)
    /// Hairline borders and dividers.
    static let ctBorder = Color(light: 0xD4D8CA, dark: 0x2A3A34)
    /// The brand green (same as the asset catalog's AccentColor).
    static let ctBrand = Color.accentColor
    /// The workspace background (same as the WorkspaceBackground asset).
    static let ctBackground = Color("WorkspaceBackground")

    init(light: UInt32, dark: UInt32) {
        self.init(uiColor: UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: 1)
        })
    }
}

/// How urgent something on the ground is. Each tone has a text name for accessibility.
enum HazardTone {
    case danger, caution, clear, info

    var color: Color {
        switch self {
        case .danger: return Color(light: 0xB42318, dark: 0xF97066)
        case .caution: return Color(light: 0xB54708, dark: 0xFDB022)
        case .clear: return Color(light: 0x236D5E, dark: 0x7DC7AB)
        case .info: return Color(light: 0x3E4784, dark: 0xA4BCFD)
        }
    }
}

extension ReportKind {
    var tone: HazardTone {
        switch self {
        case .roadBlocked, .fireSeen: return .danger
        case .heavyTraffic, .heavySmoke, .hazardDown, .shelterFull: return .caution
        case .roadPassable: return .clear
        case .helpNeeded: return .info
        }
    }
}

extension View {
    /// A raised card on the workspace background.
    func ctCard(padding: CGFloat = 16) -> some View {
        self
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.ctSurface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Color.ctBorder.opacity(0.7), lineWidth: 1))
            .shadow(color: Color.black.opacity(0.04), radius: 10, y: 4)
    }
}

/// Small uppercase label above a section, like the web workspace's eyebrows.
struct Eyebrow: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text.uppercased())
            .font(.caption.weight(.semibold))
            .tracking(0.8)
            .foregroundStyle(Color.ctMuted)
    }
}

/// A capsule with an icon and text, tinted by tone.
struct StatusPill: View {
    let text: String
    let systemImage: String
    let tone: HazardTone

    var body: some View {
        Label(text, systemImage: systemImage)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .foregroundStyle(tone.color)
            .background(tone.color.opacity(0.12), in: Capsule())
    }
}

/// Full-width filled button for the one primary action on a screen.
struct PrimaryButtonStyle: ButtonStyle {
    var tint: Color = .ctBrand

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            // Dark mode's brand green is light, so the label turns dark to keep contrast.
            .foregroundStyle(Color(light: 0xFFFFFF, dark: 0x0E1A16))
            .frame(maxWidth: .infinity, minHeight: 54)
            .background(tint.opacity(configuration.isPressed ? 0.85 : 1), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

/// Full-width outlined button for secondary actions.
struct SecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(Color.ctBrand)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(Color.ctSurface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.ctBorder, lineWidth: 1))
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}
