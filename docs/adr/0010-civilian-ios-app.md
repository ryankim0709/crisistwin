# 0010: The iOS app is the civilian app

Date: 2026-10-24. Status: accepted.

The web workspace serves emergency planners. The iOS app is for civilians, both
while planning ahead and during an emergency. Its tabs are:

- **Home:** the CrisisTwin logo from the web app (`app/public/brand`, padding
  trimmed, shown as a light single-color mark in dark mode), an official-alerts
  card, one-tap actions (**Go to my meeting point**, **Share my plan**, or
  **Choose a meeting point** when none is set), a
  summary of the household plan, and an entry to Practice. An **About** sheet
  explains the app's limits and holds the API readiness check that used to be
  on the first screen.
- **My Plan:** the household meeting plan from ADR 0009. Home and My Plan share
  one `MeetingPlanStore`, so they always show the same saved plan.
- **Practice:** the embedded web fire simulation from ADR 0007, unchanged in
  behavior, retitled and introduced with a persistent banner: "Practice only: a
  simulated fire from a simple model, not a forecast or an evacuation order."
  Only the map and simulation show: the app injects a stylesheet that hides the
  web sidebar (logo, menu, planner links) and the planning-tools panel, and the
  web view refuses navigation away from `/maps`.

## Rules this follows

- **No unofficial instructions.** No official alert source is connected, so
  the alerts card says so and points to Wireless Emergency Alerts and local
  emergency services. It never shows "all clear" and never shows mock alerts as
  live. A real feed needs an authority source and its own decision.
- **Simulation stays visibly a simulation.** Practice labels its output as
  illustrative. Phase 2 meeting-point checks (ADR 0009) will carry the same
  label.
- **Plain language and accessible controls.** Actions are large, full-width
  rows with text, so meaning never depends on icon or color alone. Accent green
  marks the primary action; red is reserved for destructive or urgent actions.

## Tradeoffs

Hiding the planner chrome from the app avoids web changes but depends on class
names in `AppShell.tsx` and `MapsPage.tsx` (`.sidebar`, `.map-planning-tools`,
`.app-layout`, `.map-page`). If they change, the chrome reappears rather than the
map breaking. A web-side embed mode (for example `/maps?embed=1`) would be the
sturdier contract if this drifts. A preparedness checklist and a Call 911
action were considered and left out for now.
