# 0006: Page-specific planning UI scaffolds

Date: 2026-10-23. Status: accepted for the hackathon UI scaffold.

Replace the five generic planned-page placeholders with dedicated React pages.
Retain the existing URLs, native anchor navigation, cream/green visual language,
and shared shell from ADR 0005. Reuse small presentation components in
`pages/WorkspaceUI.tsx`; route metadata remains in `navigation.ts`. No dependency,
API, persistence, mobile, or simulation contract changes are introduced.

Draft state belongs to each page and is discarded on navigation or reload.
Scenario inputs are not passed to the map; the UI explicitly explains this.
The map continues to own and run the existing illustrative fire model. Its
footprint visibility checkbox changes presentation only, not simulation output.

Templates, zone demand, road capacity, and shelter capacity are explicitly
synthetic editable assumptions. Demand uses people and vehicles separately;
departures use minutes relative to simulation start, shelter capacity uses people,
road capacity uses vehicles/hour, wind uses mph and meteorological degrees from
north, and provenance fields name UTC. No new calculations or modeled outcomes
are supplied by these scaffolds. For example, selecting simultaneous departures
displays zero-minute departure inputs without changing the stored wave draft.

Unavailable outputs stay empty, source connections stay disconnected, and model
execution actions are disabled with nearby explanations. Incident review has an
opt-in fictional example with no real source, observation time, or road match.
Comparison requirements and investigation questions are future workflow content,
not evaluated checks or discovered findings.

This provides concrete integration surfaces without inventing backend schemas.
Future integration must validate inputs at service boundaries, establish shared
scenario/run contracts and persistence, and replace disconnected states with
loading, success, empty, and error states using cancellation for stale requests.
