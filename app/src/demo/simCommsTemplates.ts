/**
 * Phrasing of the simulated communications (demo/simComms.ts): 911 calls, civilian reports and
 * fire / police / EMS radio lines. ASSUMPTION: the wording is authored for the drill (plain-language
 * ICS style), not taken from a recorded transcript; the repo has no real call transcripts
 * (tools/camp_road_events_table.json holds a few NIST radio lines, which only set the tone of the
 * road lines). Every generated item carries evidence "simulated". No personal names, house numbers
 * or hospital names on purpose.
 *
 * `{name}` placeholders are filled by fillTemplate; a missing one becomes a plain word.
 */

export type TemplateKey =
  | "first_report_911"
  | "sighting_dup_911"
  | "sighting_vague_911"
  | "smoke_civilian"
  | "false_report_911"
  | "spot_fire_911"
  | "homes_burning_civilian"
  | "trapped_911"
  | "trapped_no_car_911"
  | "help_evac_911"
  | "injury_burn_911"
  | "injury_smoke_911"
  | "injury_crash_911"
  | "injury_medical_911"
  | "traffic_civilian"
  | "traffic_911"
  | "traffic_pd"
  | "road_blocked_pd"
  | "road_blocked_911"
  | "road_closed_pd"
  | "evac_start_pd"
  | "evac_progress_pd"
  | "evac_clear_pd"
  | "evac_refusal_pd"
  | "evac_help_pd"
  | "fire_seen_radio"
  | "trapped_radio"
  | "other_radio"
  | "other_911"
  | "unit_dispatched_fd"
  | "unit_enroute_fd"
  | "unit_onscene_fd"
  | "unit_arrived_fd"
  | "unit_line_progress_fd"
  | "unit_line_done_fd"
  | "unit_request_fd"
  | "unit_refill_fd"
  | "unit_returning_fd"
  | "unit_cut_off_fd"
  | "unit_withdraw_fd"
  | "aircraft_drop_fd"
  | "contained_fd"
  | "camera_alert_fd"
  | "zone_overrun_fd"
  | "ems_dispatched"
  | "ems_onscene"
  | "ems_transport"
  | "ems_waiting"
  | "ems_fatal";

export const TEMPLATES: Record<TemplateKey, readonly string[]> = {
  first_report_911: [
    "I'm looking at a fire in the brush off {road}, to the {dir} of {zone}. It's moving.",
    "There's smoke and flames up the hill from {road}, maybe a few acres already.",
    "I want to report a fire. Grass is burning near {road}, {zone}. Nobody's out there yet.",
    "Big column of smoke to the {dir} of us, I can see flames in the trees past {road}.",
  ],
  sighting_dup_911: [
    "There's a {size} fire to the {dir}, near {road}. Is anyone coming?",
    "Calling about the fire by {zone}, it's getting bigger, I can see it from {road}.",
    "Flames on the ridge {dir} of {road}! Do you know about this?",
    "Just reporting the smoke over {zone}. It's {size} and it's heading our way.",
    "Fire, there's a fire, it's right up the hill from {road}. Please hurry.",
  ],
  sighting_vague_911: [
    "There's smoke somewhere up in the hills, {dir} of here, I can't tell where exactly.",
    "I see flames behind the ridge, I think it's near {zone}? I'm not sure.",
    "Somebody said there's a fire up by {zone}. I can smell it. Where is it?",
    "Orange glow to the {dir}, past the trees. I don't know the street.",
  ],
  smoke_civilian: [
    "Ash falling all over {zone}, sky is brown. Anyone know where the fire is?",
    "Heavy smoke on {road} right now, can barely see the end of the block.",
    "Embers coming down near {road}. Wetting the roof just in case.",
    "Smell of smoke everywhere in {zone}. No official word yet.",
  ],
  false_report_911: [
    "There's a new fire, I'm sure of it, smoke coming up behind the houses on {road}.",
    "Flames near {road}, {zone}! It's a second fire, it's not the big one.",
    "I see fire on the hill by {zone}. It just started, I'm looking right at it.",
    "There's smoke pouring out by {road}, I think a house is on fire.",
  ],
  spot_fire_911: [
    "Embers lit my neighbor's yard on fire, on {road}. We're spraying it with a hose.",
    "Spot fire in the brush right behind our house in {zone}, it's spreading.",
    "The hedge across {road} just caught. There's sparks everywhere.",
    "Small fire on a roof on {road}, embers keep landing. Send somebody.",
  ],
  homes_burning_civilian: [
    "Houses burning on {road}. Get out of {zone} now.",
    "Two homes on fire off {road}, no engines here yet.",
    "Whole block along {road} is going up. Smoke is black.",
    "A house on {road} is fully on fire, flames to the next one.",
  ],
  trapped_911: [
    "We're stuck at the house on {road}, fire on both sides, {people} of us. What do we do?",
    "I can't get out, the road is on fire. It's me and {relation}, {zone}.",
    "Fire's at the driveway, we can't leave. {people} people here off {road}.",
    "Please, we're trapped in {zone}, the smoke is so thick, {relation} can't walk fast.",
  ],
  trapped_no_car_911: [
    "I don't have a car and the fire's coming. It's me and {relation} on {road}.",
    "{relation} can't drive and I can't carry them. We need a ride out of {zone}.",
    "We have no way out, {people} of us, no car. We're near {road}.",
    "Can someone pick us up? {relation} uses a wheelchair, {zone}.",
  ],
  help_evac_911: [
    "We can't leave on our own, {relation} needs help getting out of {zone}.",
    "I need help getting {relation} out, we're near {road}.",
    "{relation} can't walk to the car, can someone come to {road}?",
    "{relation} is bedridden, we need help evacuating from {zone}.",
  ],
  injury_burn_911: [
    "{relation} is burned, the arms and face, it's bad. We're on {road}.",
    "Someone's burned, they tried to fight it. {zone}, near {road}. Please send an ambulance.",
    "We have {people} people hurt, burns on their hands and face, {zone}.",
    "{relation} got burned getting out of the car on {road}. Lots of pain.",
  ],
  injury_smoke_911: [
    "{relation} can't breathe, too much smoke, we're near {road}.",
    "{people} of us are coughing and dizzy, the smoke is everywhere in {zone}.",
    "{relation} has asthma and the smoke is really bad, it's getting worse.",
    "Someone collapsed in the smoke on {road}. They're breathing but barely.",
  ],
  injury_crash_911: [
    "Car crash on {road}, people evacuating, {people} hurt I think.",
    "Two cars hit each other in the smoke on {road}. Someone's bleeding.",
    "There's a wreck blocking {road}, a car went off the road, people need help.",
    "Accident on {road}, {people} people injured, traffic's not moving.",
  ],
  injury_medical_911: [
    "{relation} is having chest pains, we were trying to evacuate from {zone}.",
    "{relation} fell getting into the car and can't get up. {road}.",
    "Someone's having a seizure in the car line on {road}.",
    "{relation} is diabetic and passed out, we're stuck near {road}.",
  ],
  traffic_civilian: [
    "Stuck on {road}, haven't moved in {minutes} minutes. Fire's getting closer.",
    "{road} is a parking lot. Anybody know another way out?",
    "Bumper to bumper on {road}, smoke coming across the road.",
    "Took {minutes} minutes to go two blocks on {road}.",
  ],
  traffic_911: [
    "We're stuck in traffic on {road} and the fire is right there. What do we do?",
    "Nobody's moving on {road}, there's smoke on both sides.",
    "Traffic's completely stopped on {road}, we can't get out.",
  ],
  traffic_pd: [
    "{unit}: {road} is at a standstill, about {queue} vehicles backed up. Need traffic control.",
    "{unit}: heavy outbound traffic on {road}, queue of {queue} cars. Requesting another unit for the intersection.",
    "{unit}: gridlock on {road}. I'll start waving people through, need help at the top.",
    "{unit}: {road} is stopped, {queue} vehicles. Can we open up the other lanes outbound?",
  ],
  road_blocked_pd: [
    "{unit}: {road} is blocked, fire across the roadway. Turning cars around.",
    "{unit}: downed lines and fire on {road}. It's impassable.",
    "{unit}: abandoned cars blocking {road}. Pushing them off now.",
    "{unit}: {road} is not passable, burning vegetation both sides.",
  ],
  road_blocked_911: [
    "{road} is blocked, there's fire on the road, we had to turn around.",
    "A tree's down across {road}, it's burning. We can't get through.",
    "Is there another way out? {road} is closed off by the fire.",
  ],
  road_closed_pd: [
    "{unit}: hard closure set at {road}. No traffic in.",
    "{unit}: closing {road} at the intersection, diverting outbound traffic.",
    "{unit}: {road} is closed, units only.",
  ],
  evac_start_pd: [
    "{unit}: starting door-to-door in {zone}, hi-lo on.",
    "{unit}: beginning evacuation notifications in {zone}.",
    "{unit}: in {zone} now, knocking doors, telling people to leave.",
  ],
  evac_progress_pd: [
    "{unit}: {zone} is about {pct} percent out, traffic still heavy.",
    "{unit}: about {pct} percent of {zone} has left, still working the upper streets.",
    "{unit}: {zone} roughly {pct} percent clear.",
  ],
  evac_clear_pd: [
    "{unit}: {zone} is clear as far as we can tell, last cars heading out.",
    "{unit}: finished the sweep of {zone}. Moving out.",
    "{unit}: {zone} looks clear.",
  ],
  evac_refusal_pd: [
    "{unit}: about {count} households in {zone} refusing to leave. Moving on.",
    "{unit}: some residents in {zone} staying to defend, roughly {count} homes.",
    "{unit}: {count} homes in {zone} won't go. Logged them.",
  ],
  evac_help_pd: [
    "{unit}: I have residents in {zone} with no ride out, need a transport.",
    "{unit}: elderly residents in {zone} need help leaving, requesting a unit to assist.",
    "{unit}: mobility-impaired party in {zone} near {road}, need help moving them.",
  ],
  fire_seen_radio: [
    "{unit}: fire visible from {road}, moving toward {zone}.",
    "{unit}: I have flames at the edge of {zone} now.",
    "{unit}: fire has crossed above {road}.",
  ],
  trapped_radio: [
    "{unit}: we have people sheltering near {road}, fire around them. Need an engine.",
    "{unit}: civilians trapped in {zone}, can't reach them, fire on the road.",
    "{unit}: report of a family cut off on {road}.",
  ],
  other_radio: [
    "{unit}: checking on {zone}, smoke is heavy.",
    "{unit}: staging near {road}.",
    "{unit}: copy, moving to {zone}.",
    "{unit}: confirming {road} is still open outbound.",
  ],
  other_911: [
    "Is {zone} under evacuation? We don't know what to do.",
    "Where's the shelter? We're leaving {zone}.",
    "My neighbor isn't answering her phone, she lives near {road}.",
    "There's a lot of smoke near {road}, is it safe to stay?",
    "Is {road} open? We're trying to leave {zone}.",
  ],
  unit_dispatched_fd: [
    "ECC: {unit}, respond to the vegetation fire {incident}, near {road}.",
    "ECC: {unit}, you're assigned to {incident}, {zone}.",
    "ECC: {unit}, respond to {incident}, reported near {road}.",
  ],
  unit_enroute_fd: [
    "{unit} responding to {incident}, ETA {minutes} minutes.",
    "{unit} en route to {incident}, about {minutes} out.",
    "{unit} copies, en route, {minutes} minutes.",
  ],
  unit_onscene_fd: [
    "{unit} on scene, {incident}: about {acres} acres, {spread} rate of spread, structures threatened in {zone}.",
    "{unit} on scene. Fire is roughly {acres} acres, {spread} spread, I'll take command.",
    "{unit} arriving, {acres} acres in grass and brush, {spread} spread toward {zone}.",
    "{unit} on scene, starting an anchor point. Fire about {acres} acres, {spread} rate of spread.",
  ],
  unit_arrived_fd: [
    "{unit} on scene, {incident}.",
    "{unit} on scene, checking in with command on {incident}.",
    "{unit} arriving at {incident}.",
  ],
  unit_line_progress_fd: [
    "{unit}: {incident}, line is about {pct} percent around.",
    "{unit}: making progress, {pct} percent of the line in.",
    "{unit}: line is {pct} percent, holding so far.",
  ],
  unit_line_done_fd: [
    "{unit}: line complete at our position on {incident}.",
    "{unit}: we tied in our line on {incident}.",
    "{unit}: finished our segment of line, {incident}.",
  ],
  unit_request_fd: [
    "{unit}: {incident} is getting away from us, requesting {request}.",
    "{unit}: we won't hold this with what we have. Order {request}.",
    "{unit}: {incident} command, requesting {request}.",
  ],
  unit_refill_fd: [
    "{unit}: out of water, leaving the line to refill.",
    "{unit}: tank's empty, going to fill and come back.",
    "{unit}: heading to the hydrant to refill.",
  ],
  unit_returning_fd: [
    "{unit} released, returning to quarters.",
    "{unit} available, heading back to the station.",
    "{unit} clear of the incident, returning.",
  ],
  unit_cut_off_fd: [
    "{unit}: fire's across {road}, we have to turn around.",
    "{unit}: our route on {road} is cut by fire, rerouting.",
    "{unit}: can't get through on {road}, too much fire.",
  ],
  unit_withdraw_fd: [
    "{unit}: fire jumped our line on {incident}, pulling back to the safety zone.",
    "{unit}: line's been overrun, crews are disengaging.",
    "{unit}: we lost the line, everyone's backing out.",
  ],
  aircraft_drop_fd: [
    "{unit} making a drop on the head of {incident}.",
    "{unit}: retardant drop complete on {incident}.",
    "{unit} on the left flank of {incident}, dropping.",
  ],
  contained_fd: [
    "{unit}: forward progress stopped on {incident}, about {acres} acres.",
    "{unit}: {incident} is contained, {acres} acres. Mopping up.",
    "{unit}: we have a hold on {incident}, {acres} acres.",
  ],
  camera_alert_fd: [
    "ECC: camera network picked up a new smoke {dir} of {zone}. Sending a unit to check.",
    "ECC: new detection from the camera system near {zone}, to the {dir}.",
    "ECC: satellite heat detection near {zone}. Confirming.",
  ],
  zone_overrun_fd: [
    "{unit}: fire is in {zone} now. Homes involved.",
    "{unit}: {zone} is burning, structures on fire.",
    "{unit}: fire has made it into {zone}.",
  ],
  ems_dispatched: [
    "{unit} responding to {zone}, {people} patients, {cause}.",
    "Dispatch: {unit}, {cause} near {road}, {people} patients.",
    "{unit} copies, en route to {zone}, {cause}.",
  ],
  ems_onscene: [
    "{unit} on scene, {people} patients, {cause}. Treating now.",
    "{unit} with the patients, {cause}.",
    "{unit} on scene, assessing {people}.",
  ],
  ems_transport: [
    "{unit} transporting {people} to the hospital.",
    "{unit} is leaving the scene with {people} patients.",
    "{unit} transporting, patient stable.",
  ],
  ems_waiting: [
    "Dispatch: {people} patients still waiting in {zone}, {cause}, no medic assigned.",
    "Dispatch: we have an open medical call in {zone}, {cause}, waiting {minutes} minutes.",
    "Dispatch: still no unit for the {cause} call in {zone}.",
  ],
  ems_fatal: [
    "{unit}: patient in {zone} did not survive.",
    "{unit}: we have a fatality in {zone}.",
  ],
};

export const SPEAKERS: Record<TemplateKey, readonly string[]> = {
  first_report_911: ["Caller on {road}", "Caller near {zone}", "Passing driver on {road}"],
  sighting_dup_911: ["Caller on {road}", "Caller near {zone}", "Resident, {zone}", "Passing driver on {road}"],
  sighting_vague_911: ["Caller, location unclear", "Cell caller near {zone}"],
  smoke_civilian: ["Neighborhood app post, {zone}", "Social media, {zone}", "Walk-up report, {road}"],
  false_report_911: ["Caller on {road}", "Caller near {zone}"],
  spot_fire_911: ["Resident, {zone}", "Caller on {road}"],
  homes_burning_civilian: ["Social media, {zone}", "Neighborhood app post, {zone}"],
  trapped_911: ["Caller on {road}", "Resident, {zone}"],
  trapped_no_car_911: ["Resident, {zone}", "Caller on {road}"],
  help_evac_911: ["Resident, {zone}", "Caller on {road}"],
  injury_burn_911: ["Caller on {road}", "Caller near {zone}"],
  injury_smoke_911: ["Caller on {road}", "Caller near {zone}"],
  injury_crash_911: ["Passing driver on {road}", "Caller on {road}"],
  injury_medical_911: ["Caller on {road}", "Resident, {zone}"],
  traffic_civilian: ["Social media, {road}", "Neighborhood app post, {zone}"],
  traffic_911: ["Caller on {road}", "Driver on {road}"],
  traffic_pd: ["{unit}"],
  road_blocked_pd: ["{unit}"],
  road_blocked_911: ["Driver on {road}", "Caller on {road}"],
  road_closed_pd: ["{unit}"],
  evac_start_pd: ["{unit}"],
  evac_progress_pd: ["{unit}"],
  evac_clear_pd: ["{unit}"],
  evac_refusal_pd: ["{unit}"],
  evac_help_pd: ["{unit}"],
  fire_seen_radio: ["{unit}"],
  trapped_radio: ["{unit}"],
  other_radio: ["{unit}"],
  other_911: ["Caller near {zone}", "Resident, {zone}"],
  unit_dispatched_fd: ["ECC dispatch"],
  unit_enroute_fd: ["{unit}"],
  unit_onscene_fd: ["{unit}"],
  unit_arrived_fd: ["{unit}"],
  unit_line_progress_fd: ["{unit}"],
  unit_line_done_fd: ["{unit}"],
  unit_request_fd: ["{unit}"],
  unit_refill_fd: ["{unit}"],
  unit_returning_fd: ["{unit}"],
  unit_cut_off_fd: ["{unit}"],
  unit_withdraw_fd: ["{unit}"],
  aircraft_drop_fd: ["{unit}"],
  contained_fd: ["{unit}"],
  camera_alert_fd: ["ECC dispatch"],
  zone_overrun_fd: ["{unit}"],
  ems_dispatched: ["{unit}"],
  ems_onscene: ["{unit}"],
  ems_transport: ["{unit}"],
  ems_waiting: ["Dispatch"],
  ems_fatal: ["{unit}"],
};

/** Relations for injury and trapped calls (never personal names). */
export const RELATIONS: readonly string[] = [
  "my husband",
  "my wife",
  "my mother",
  "my father",
  "my neighbor",
  "my son",
  "my daughter",
  "an older woman next door",
  "an older man down the street",
  "my grandmother",
];

const FALLBACK: Readonly<Record<string, string>> = {
  road: "the road",
  zone: "the hills",
  dir: "north",
  size: "big",
  unit: "unit",
  incident: "the fire",
  people: "a few",
  relation: "my neighbor",
  minutes: "several",
  queue: "dozens of",
  pct: "half",
  count: "a few",
  acres: "a few",
  spread: "moderate",
  request: "more resources",
  cause: "injury",
};

/** Fill `{name}` placeholders; a missing one becomes a plain fallback word (never leaves braces). */
export function fillTemplate(template: string, vars: Readonly<Record<string, string | number>>): string {
  const out = template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = vars[name];
    return v === undefined || v === "" ? (FALLBACK[name] ?? "") : String(v);
  });
  // A sentence that starts with a filled lower-case word ("my husband is burned") gets a capital.
  return out.charAt(0).toUpperCase() + out.slice(1);
}
