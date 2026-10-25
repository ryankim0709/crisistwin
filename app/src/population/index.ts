/**
 * Shared population module: who lives where and where they are during a simulated evacuation,
 * used identically by Simulation Studio (/simulation) and the Dispatch agent (/dispatch).
 *
 * - households.ts: household source. Scenario-snapshot households (MongoDB
 *   `snapshot_households`, read through GET /api/dispatch/households: estimated occupants,
 *   evacuating vehicles, needs-transport) matched to the dispatch area's zones; without a
 *   covering snapshot, the area's synthetic homes × 1.38 persons per vehicle.
 * - householdBehavior.ts: grounded household behaviour (order compliance and departure delays
 *   from fire surveys) applied through DispatchEngine.setDepartureDelays.
 * - peopleSnapshot.ts: DispatchEngine state → /live People snapshot.
 * - PopulationView.tsx: the /live people map layer and summary strip for an engine.
 * - hooks.ts: useZoneHouseholds (household source for an area), useClockSteppedPlayer.
 */

export * from "./householdBehavior";
export * from "./households";
export * from "./peopleSnapshot";
export * from "./hooks";
export { default as PopulationView, PEOPLE_BEFORE_LAYER, type PopulationViewProps } from "./PopulationView";
