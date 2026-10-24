# 0018: iOS 26 baseline for the phone app

Date: 2026-10-24. Status: accepted. Supersedes the version line of
[0004-mobile-swift-scaffold](0004-mobile-swift-scaffold.md) ("iOS 17+, Xcode 16.2+").

## Context

The phone app was one map screen with a hamburger menu. The user asked for a native tab app
in the iOS 26 look (Liquid Glass), with a Home screen, and for newer platform features where
they help the person on the ground (user directives D5, D6 and D9; design spec in the live
loop). Supporting iOS 17 too would mean `#available` branches around every one of those APIs
and a second, older look to keep working.

## Decision

- `IPHONEOS_DEPLOYMENT_TARGET` is **26.0** in both build configurations. Building needs
  **Xcode 26** (the iOS 26 SDK). The project stays in **Swift 5 language mode** and uses Apple
  frameworks only.
- iOS 26 APIs are used directly, with no `#available` branches: the `Tab` API with
  `tabViewBottomAccessory` and `tabBarMinimizeBehavior(.onScrollDown)`, `glassEffect`,
  `GlassEffectContainer` and `glassEffectID` for the floating map controls and check-ins,
  `.glass` / `.glassProminent` button styles, `navigationSubtitle`, `ButtonRole.close`,
  SF Symbols 7 draw-on, and MapKit's realistic elevation with muted emphasis.
- APIs newer than 26.0 are not used. In particular `tabViewBottomAccessory(isEnabled:)` needs
  26.1, so the accessory is attached conditionally instead.
- The root is a `TabView`: Home, Map, Reports, Plan, and Tasks for responders. The hamburger
  menu (`AppMenu.swift`) is deleted; Family and the web simulation feed
  ([0016-resident-live-and-family](0016-resident-live-and-family.md)) live in Plan.

## Consequences

- Devices that cannot run iOS 26 cannot install the app. For a hackathon demo on current
  iPhones and simulators this is acceptable.
- Teammates need Xcode 26 to build. The version lines in `README.md` and `mobile/README.md`
  say so.
- No server or contract change.
