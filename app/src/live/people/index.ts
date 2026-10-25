// Simulated people picture (docs/twin-api.md "People snapshot"): data hook, MapLibre layer, summary strip.
// Self-contained so any map view (the /live command map, an app integration tab) can host it.
export { attachPeopleLayer, MOTION_SCALE, PEOPLE_INTERACTIVE_LAYERS, PEOPLE_LAYER_IDS, peoplePerDot } from "./peopleLayer";
export type { PeopleLayer } from "./peopleLayer";
export { default as PeopleSummary, PEOPLE_SWATCH } from "./PeopleSummary";
export { fetchPeople, usePeople } from "./usePeople";
export { PEOPLE_COLOR } from "./palette";
export type * from "./types";
