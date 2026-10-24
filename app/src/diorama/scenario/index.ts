/**
 * Deterministic scripted scenario for the fictional Larkspur Hollow wildfire evacuation
 * diorama. `createScenario(world)` precomputes everything once (fire field, evacuation
 * timings, vehicle trajectories at a fixed step); `sample(t)` interpolates a snapshot.
 *
 * Story (scenario seconds, boundaries partly derived from the simulation):
 * ignition 0–8 · spread 8–first order · evacuation orders in three waves · congestion while
 * the Mill Creek Bridge queue builds · crew response once engines are staged · resolution.
 *
 * Simplifications (see docs/adr/0010-evacuation-diorama.md): scripted fire grid, simple
 * follow-the-leader traffic, carpooling neighbours, crew hold as a scripted ignition block.
 * Everything is synthetic; nothing here is operational guidance.
 */
import type {
  Counters,
  CrewState,
  Household,
  PedestrianState,
  Phase,
  PhaseId,
  PickTarget,
  RecapItem,
  RoadEdge,
  Scenario,
  SimSnapshot,
  Staging,
  Vec2,
  VehicleState,
  World,
} from "../types";
import { SCENARIO_DURATION_S } from "../types";
import { createRng, dist, pointAtDistance, WORLD_SEED } from "../world";
import { buildFire, countIgnitedBy } from "./fire";
import { addPrivateLane, buildNetwork, hopsFrom, PathBuilder, shortestTo } from "./routing";
import {
  simulate,
  SIM_DT,
  statusAt,
  type Closure,
  type SimResult,
  type VehiclePlan,
} from "./traffic";

const TOWN = "Larkspur Hollow";
const BRIDGE_NAME = "Mill Creek Bridge";

/** Evacuation order waves by home position (z grows south). */
const WAVES = [
  {
    id: "upper",
    t: 14,
    maxZ: -20,
    caption: "Evacuation order for Ridge Lane and the upper streets of Larkspur Hollow.",
  },
  {
    id: "central",
    t: 20,
    maxZ: 45,
    caption: "The evacuation order expands to central Larkspur Hollow.",
  },
  {
    id: "south",
    t: 26,
    maxZ: Infinity,
    caption: "Southern streets are ordered to leave; every route leads to Mill Creek Bridge.",
  },
] as const;
/** Households in a wave receive the order over this many seconds. */
const ORDER_SPREAD_S = 2.5;
/** Residents start walking 0.8–3.0 s after the order, 0.6 s apart. */
const REACTION_MIN_S = 0.8;
const REACTION_SPREAD_S = 2.2;
const RESIDENT_STAGGER_S = 0.6;
const WALK_SPEED = 2.4;
/** Even a short walk to the car takes this long (gathering belongings, buckling in). */
const MIN_WALK_S = 1.8;
const BOARD_DELAY_S = 1;

/** Small households ride with a neighbour on the same street until at most this many cars leave. */
const MAX_EVACUATING_CARS = 26;
const MAX_GUEST_HOUSEHOLDS = 2;
const CAR_SEATS = 6;
const CARPOOL_RADIUS = 80;
const CARPOOL_MAX_RESIDENTS = 3;

const CAR = { length: 4.4, maxSpeed: 16, limitFactor: 1, accel: 4.5 };
const ENGINE = { length: 7.5, maxSpeed: 18, limitFactor: 1.35, accel: 3.4, crew: 4 };
const ENGINE_NAMES = ["Engine 7-1", "Engine 7-2", "Engine 7-3"];
/** Engine 7-1 → Ridge Lane homes, 7-2 → east flank, 7-3 → west flank. */
const ENGINE_STAGING_ORDER = ["ridge-lane", "east-flank", "west-flank"];
const ENGINE_DEPART_S = [42, 44, 46];
const SPRAY_DELAY_S = 2;

/** One vehicle onto the single-lane bridge per interval. */
const BRIDGE_INTERVAL_S = 1.0;
/** At least this many queued cars near the bridge shows the bottleneck marker. */
const BOTTLENECK_MIN_QUEUE = 3;
const BOTTLENECK_HOLD_S = 2.5;

/** Ridge Lane segment closed when the fire edge comes within this distance. */
const CLOSED_EDGE_ID = "U2-U3";
const CLOSURE_FIRE_DISTANCE = 20;
const CLOSURE_MIN_S = 28;
const CLOSURE_MAX_S = 40;
/** Routes avoid edges that close within this many seconds after departure. */
const CLOSURE_LOOKAHEAD_S = 25;

/** Crew-held fire sections: fuel cells within this radius of the unburned perimeter nearest each staging. */
const HOLD_RADIUS = 45;
const HOLD_STAGINGS = ["ridge-lane", "east-flank", "west-flank"];

const CAPTION_MIN_GAP_S = 3.5;
/** The congestion phase label starts no earlier than this, once the queue is substantial. */
const CONGESTION_PHASE_MIN_S = 36;

type Resident = {
  householdId: string;
  vehicle: number;
  walkStart: number;
  walkEnd: number;
  from: Vec2;
  to: Vec2;
  id: string;
};

type CivilianInfo = {
  household: Household;
  vehicle: number;
  /** Households riding in this car (including its own), for hosts. */
  riders: string[];
  order: number;
};

const fmtS = (t: number) => `${Math.round(t)} s`;
/** "East flank" → "the east flank"; proper names such as "Ridge Lane homes" stay as they are. */
const placeName = (label: string) => (/flank$/i.test(label) ? `the ${label.toLowerCase()}` : label);

function hashUnit(rng: () => number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(rng());
  return out;
}

export function createScenario(world: World): Scenario {
  const duration = SCENARIO_DURATION_S;
  const net = buildNetwork(world);
  const homeById = new Map(world.buildings.map((b) => [b.id, b]));
  const stagingById = new Map(world.stagings.map((s) => [s.id, s]));
  const shelterBuilding = homeById.get(world.shelter.buildingId);
  const stationBuilding = homeById.get(world.station.buildingId);
  if (!shelterBuilding || !stationBuilding) throw new Error("Shelter or station building missing");
  const shelterNode = net.nodePos.get(world.shelter.nodeId)!;
  const stationNode = net.nodePos.get(world.station.nodeId)!;
  const bridgeEdge = net.edgeById.get(world.bridgeEdgeId);
  if (!bridgeEdge || bridgeEdge.kind !== "bridge") throw new Error("Bridge edge missing");

  // ---- Fire pass 1: when does the fire threaten Ridge Lane? -------------------------------
  const closedEdge = net.edgeById.get(CLOSED_EDGE_ID);
  if (!closedEdge || closedEdge.kind === "fire-road") throw new Error("Closure edge missing");
  const firePreview = buildFire(world, duration, null);
  const approach = firePreview.approachTime(closedEdge.points, CLOSURE_FIRE_DISTANCE);
  const closeTime = Math.round(Math.min(CLOSURE_MAX_S, Math.max(CLOSURE_MIN_S, approach)) * 2) / 2;
  const closures: Closure[] = [{ edgeId: CLOSED_EDGE_ID, t: closeTime }];

  // ---- Households: waves, carpools, walking ----------------------------------------------
  const rng = createRng(WORLD_SEED ^ 0xe7ac);
  const households = world.households;
  const jitterOrder = hashUnit(rng, households.length);
  const jitterReact = hashUnit(rng, households.length);
  const waveOf = (h: Household) => {
    const home = homeById.get(h.homeId)!;
    return WAVES.findIndex((w) => home.p.z < w.maxZ);
  };
  const orderTime = new Map<string, number>();
  const reactTime = new Map<string, number>();
  households.forEach((h, idx) => {
    const wave = WAVES[waveOf(h)];
    // Homes on the soon-to-close Ridge Lane segment hear first and move fastest.
    const urgent = h.edgeId === CLOSED_EDGE_ID;
    orderTime.set(h.id, wave.t + (urgent ? 0 : jitterOrder[idx] * ORDER_SPREAD_S));
    reactTime.set(
      h.id,
      urgent ? REACTION_MIN_S * 0.5 : REACTION_MIN_S + jitterReact[idx] * REACTION_SPREAD_S,
    );
  });

  // Carpooling: small households join a neighbour on the same street and wave.
  const hostOf = new Map<string, string>(households.map((h) => [h.id, h.id]));
  const seats = new Map<string, number>(households.map((h) => [h.id, h.residents]));
  const guests = new Map<string, number>(households.map((h) => [h.id, 0]));
  let cars = households.length;
  const candidates = households
    .filter((h) => h.residents <= CARPOOL_MAX_RESIDENTS && h.edgeId !== CLOSED_EDGE_ID)
    .sort((a, b) => a.residents - b.residents || households.indexOf(a) - households.indexOf(b));
  for (const c of candidates) {
    if (cars <= MAX_EVACUATING_CARS) break;
    if (guests.get(c.id)! > 0) continue;
    let best: Household | null = null;
    for (const h of households) {
      if (
        h.id === c.id ||
        hostOf.get(h.id) !== h.id ||
        h.edgeId !== c.edgeId ||
        waveOf(h) !== waveOf(c)
      )
        continue;
      if (guests.get(h.id)! >= MAX_GUEST_HOUSEHOLDS || seats.get(h.id)! + c.residents > CAR_SEATS)
        continue;
      const d = dist(h.parking, c.parking);
      if (d > CARPOOL_RADIUS) continue;
      if (!best || d < dist(best.parking, c.parking)) best = h;
    }
    if (!best) continue;
    hostOf.set(c.id, best.id);
    seats.set(best.id, seats.get(best.id)! + c.residents);
    guests.set(best.id, guests.get(best.id)! + 1);
    cars--;
  }
  // Riders take the host's order time so the car leaves together.
  for (const h of households) {
    const host = hostOf.get(h.id)!;
    if (host !== h.id) orderTime.set(h.id, Math.max(orderTime.get(h.id)!, orderTime.get(host)!));
  }

  // ---- Shelter parking lot ----------------------------------------------------------------
  const aisleZ = shelterNode.z + 2;
  const lotLanePoints: Vec2[] = [
    shelterNode,
    { x: shelterNode.x + 6, z: aisleZ },
    { x: shelterNode.x + 70, z: aisleZ },
  ];
  const lotLane = addPrivateLane(net, "shelter-lot", lotLanePoints);
  const shelterFrontZ = shelterBuilding.p.z - shelterBuilding.d / 2;
  const slots: { p: Vec2; heading: number; aisleX: number }[] = [];
  for (let k = 0; k < 18; k++) {
    const sx = shelterNode.x + 8 + k * 3.4;
    const aisleX = dist(lotLanePoints[0], lotLanePoints[1]) + (sx - lotLanePoints[1].x);
    // Front row noses toward the hall (+z); back row noses away (−z).
    const front = { x: sx, z: Math.min(aisleZ + 5.5, shelterFrontZ - 3) };
    slots.push({ p: front, heading: 0, aisleX });
    slots.push({ p: { x: sx, z: aisleZ - 5.5 }, heading: Math.PI, aisleX });
  }

  // ---- Routing helpers ----------------------------------------------------------------------
  const routeCache = new Map<string, ReturnType<typeof shortestTo>>();
  const routeTable = (target: string, kind: "civilian" | "engine", depart: number) => {
    const closedSoon = closures
      .filter((c) => c.t < depart + CLOSURE_LOOKAHEAD_S)
      .map((c) => c.edgeId);
    const key = `${target}|${kind}|${closedSoon.join(",")}`;
    let table = routeCache.get(key);
    if (!table) {
      const excluded = (e: RoadEdge) =>
        closedSoon.includes(e.id) || (kind === "civilian" && e.kind === "fire-road");
      const speed = (e: RoadEdge) =>
        kind === "engine" ? Math.min(ENGINE.maxSpeed, e.speed * ENGINE.limitFactor) : e.speed;
      table = shortestTo(net, target, excluded, speed);
      routeCache.set(key, table);
    }
    return { table, closedSoon };
  };

  // ---- Civilian vehicle plans ---------------------------------------------------------------
  const plans: VehiclePlan[] = [];
  const civilians: CivilianInfo[] = [];
  const residents: Resident[] = [];
  const vehicleOfHousehold = new Map<string, number>();
  const pendingCars: { idx: number; build: (slot: number) => void; eta: number }[] = [];

  const doorOf = (h: Household) => {
    const b = homeById.get(h.homeId)!;
    const off = b.d / 2 + 1;
    return { x: b.p.x + Math.sin(b.rotation) * off, z: b.p.z + Math.cos(b.rotation) * off };
  };

  // Each household's own car (riders' cars stay parked).
  households.forEach((h) => {
    const idx = plans.length;
    vehicleOfHousehold.set(h.id, idx);
    const edge = net.edgeById.get(h.edgeId)!;
    const len = net.edgeLen.get(h.edgeId)!;
    const along = pointAtDistance(edge.points, h.edgeT * len);
    plans.push({
      id: `car-${h.id}`,
      kind: "civilian",
      length: CAR.length,
      segs: [],
      boardFrom: Infinity,
      depart: Infinity,
      restHeading: along.heading,
      maxSpeed: CAR.maxSpeed,
      limitFactor: CAR.limitFactor,
      accel: CAR.accel,
      bridgeS: Infinity,
      arriveS: Infinity,
    });
    civilians.push({ household: h, vehicle: idx, riders: [], order: orderTime.get(h.id)! });
  });

  for (const h of households) {
    const host = hostOf.get(h.id)!;
    const vIdx = vehicleOfHousehold.get(host)!;
    civilians[vIdx].riders.push(h.id);
    const hostHh = households.find((x) => x.id === host)!;
    const door = doorOf(h);
    const start = orderTime.get(h.id)! + reactTime.get(h.id)!;
    // Perpendicular spread so residents do not walk on top of each other.
    const dx = hostHh.parking.x - door.x;
    const dz = hostHh.parking.z - door.z;
    const dl = Math.hypot(dx, dz) || 1;
    for (let k = 0; k < h.residents; k++) {
      const side = (k - (h.residents - 1) / 2) * 0.9;
      const from = { x: door.x + (-dz / dl) * side, z: door.z + (dx / dl) * side };
      const to = {
        x: hostHh.parking.x + (-dz / dl) * side * 0.6,
        z: hostHh.parking.z + (dx / dl) * side * 0.6,
      };
      const walkStart = start + k * RESIDENT_STAGGER_S;
      residents.push({
        householdId: h.id,
        vehicle: vIdx,
        walkStart,
        walkEnd: walkStart + Math.max(MIN_WALK_S, dist(from, to) / WALK_SPEED),
        from,
        to,
        id: `ped-${h.id}-${k + 1}`,
      });
    }
  }

  for (const info of civilians) {
    const h = info.household;
    const plan = plans[info.vehicle];
    const edge = net.edgeById.get(h.edgeId)!;
    const len = net.edgeLen.get(h.edgeId)!;
    const roadPoint = pointAtDistance(edge.points, h.edgeT * len).p;
    const curb = {
      x: roadPoint.x + (h.parking.x - roadPoint.x) * 0.8,
      z: roadPoint.z + (h.parking.z - roadPoint.z) * 0.8,
    };
    if (info.riders.length === 0) {
      // A rider household's own car stays at home.
      const b = new PathBuilder(net);
      b.parkingStub([h.parking, h.parking]);
      plan.segs = b.segs;
      continue;
    }
    const mine = residents.filter((r) => r.vehicle === info.vehicle);
    plan.boardFrom = Math.min(...mine.map((r) => r.walkStart));
    plan.depart = Math.max(...mine.map((r) => r.walkEnd)) + BOARD_DELAY_S;
    const ownClose = closures.find((c) => c.edgeId === h.edgeId);
    if (ownClose && ownClose.t <= plan.depart) {
      throw new Error(`${plan.id} departs at ${plan.depart.toFixed(1)} s after its street closes`);
    }
    const { table, closedSoon } = routeTable(world.shelter.nodeId, "civilian", plan.depart);
    const options = [
      { forward: true, node: edge.to, part: len * (1 - h.edgeT) },
      { forward: false, node: edge.from, part: len * h.edgeT },
    ].map((o) => ({ ...o, cost: o.part / edge.speed + (table.cost.get(o.node) ?? Infinity) }));
    const choice = options[0].cost <= options[1].cost ? options[0] : options[1];
    if (!Number.isFinite(choice.cost)) throw new Error(`${plan.id} cannot reach the shelter`);
    const hops = hopsFrom(choice.node, world.shelter.nodeId, table.next, net);
    for (const hop of hops) {
      if (closedSoon.includes(hop.edge.id))
        throw new Error(`${plan.id} routed over closed edge ${hop.edge.id}`);
    }
    const startLaneX = choice.forward ? h.edgeT * len : (1 - h.edgeT) * len;
    plan.restHeading =
      pointAtDistance(edge.points, h.edgeT * len).heading + (choice.forward ? 0 : Math.PI);
    const eta = plan.depart + choice.cost + 4;
    pendingCars.push({
      idx: info.vehicle,
      eta,
      build: (slotIdx: number) => {
        const b = new PathBuilder(net);
        b.driveway([h.parking, curb]);
        b.edge({ edge, forward: choice.forward }, startLaneX);
        for (const hop of hops) b.edge(hop);
        if (slotIdx < slots.length) {
          const slot = slots[slotIdx];
          b.privateLane(lotLane, slot.aisleX);
          b.parkingStub([{ x: slot.p.x, z: aisleZ }, slot.p]);
        } else {
          b.privateLane(lotLane, net.lanes[lotLane].len);
        }
        plan.segs = b.segs;
        plan.arriveS = b.segs.find((sg) => sg.lane === lotLane)!.s0;
        const bridgeSeg = b.segs.find((sg) => sg.bridge);
        plan.bridgeS = bridgeSeg ? bridgeSeg.s0 : Infinity;
        if (!bridgeSeg) throw new Error(`${plan.id} route misses ${BRIDGE_NAME}`);
      },
    });
  }
  // Nearest parking slots go to the cars expected first.
  pendingCars.sort((a, b) => a.eta - b.eta || a.idx - b.idx).forEach((c, k) => c.build(k));
  const overflowFrom = slots.length;
  const slotOfVehicle = new Map(pendingCars.map((c, k) => [c.idx, k]));

  // ---- Engines -----------------------------------------------------------------------------
  const engineStart = plans.length;
  const engineStagings: Staging[] = [];
  const stationFront = stationBuilding.p.z - stationBuilding.d / 2;
  for (let k = 0; k < world.station.engines; k++) {
    const staging =
      stagingById.get(ENGINE_STAGING_ORDER[k]) ?? world.stagings[k % world.stagings.length];
    engineStagings.push(staging);
    const depart = ENGINE_DEPART_S[k] ?? ENGINE_DEPART_S[ENGINE_DEPART_S.length - 1] + 2 * k;
    const apron = {
      x: stationNode.x + (k - (world.station.engines - 1) / 2) * 6,
      z: stationFront - 4,
    };
    const { table, closedSoon } = routeTable(staging.nodeId, "engine", depart);
    const firstHop = table.next.get(world.station.nodeId);
    if (!firstHop) throw new Error(`No route from ${world.station.label} to ${staging.label}`);
    const hops = hopsFrom(world.station.nodeId, staging.nodeId, table.next, net);
    for (const hop of hops) {
      if (closedSoon.includes(hop.edge.id))
        throw new Error(`Engine routed over closed edge ${hop.edge.id}`);
    }
    const b = new PathBuilder(net);
    b.driveway([apron, { x: (apron.x + stationNode.x) / 2, z: (apron.z + stationNode.z) / 2 }]);
    for (const hop of hops) b.edge(hop);
    const stagingNode = net.nodePos.get(staging.nodeId)!;
    b.privateSeg([stagingNode, staging.p], 5);
    plans.push({
      id: `engine-${k + 1}`,
      kind: "engine",
      length: ENGINE.length,
      segs: b.segs,
      boardFrom: Infinity,
      depart,
      restHeading: Math.atan2(stationNode.x - apron.x, stationNode.z - apron.z),
      maxSpeed: ENGINE.maxSpeed,
      limitFactor: ENGINE.limitFactor,
      accel: ENGINE.accel,
      bridgeS: Infinity,
      arriveS: Infinity,
    });
  }

  // ---- Traffic -----------------------------------------------------------------------------
  const sim: SimResult = simulate(plans, net.lanes, {
    duration,
    bridgeInterval: BRIDGE_INTERVAL_S,
    closures,
  });
  const engineIdx = plans.map((_, i) => i).filter((i) => i >= engineStart);
  const sprayStart = engineIdx.map((i) => sim.arrival[i] + SPRAY_DELAY_S);

  // ---- Fire pass 2 with the crew hold -------------------------------------------------------
  const holdEngines = engineIdx.filter((_, k) => HOLD_STAGINGS.includes(engineStagings[k].id));
  const heldFrom = Math.max(...holdEngines.map((i) => sim.arrival[i] + SPRAY_DELAY_S));
  // Each crew holds the stretch of perimeter nearest its staging: centred on the closest
  // forest cell the fire has not reached yet when the water starts.
  const holdCenters = engineStagings
    .filter((s) => HOLD_STAGINGS.includes(s.id))
    .map((s) => firePreview.nearestUnburned(s.p, heldFrom))
    .filter((p): p is Vec2 => p !== null);
  const fireBuild = buildFire(
    world,
    duration,
    Number.isFinite(heldFrom) ? { heldFrom, centers: holdCenters, radius: HOLD_RADIUS } : null,
  );
  const fire = fireBuild.field;

  // ---- Derived timelines -------------------------------------------------------------------
  const frameOf = (t: number) =>
    Math.min(sim.frames - 1, Math.max(0, Math.floor(t / SIM_DT + 1e-6)));
  const arrivalFrame = sim.arrivalFrame;
  const population = residents.length;
  // The marker stays on for a short hold so a stop-and-go queue does not flicker.
  const holdFrames = Math.round(BOTTLENECK_HOLD_S / SIM_DT);
  const bottleneck: boolean[] = [];
  let lastQueued = -Infinity;
  sim.nearBridgeQueued.forEach((q, k) => {
    if (q >= BOTTLENECK_MIN_QUEUE) lastQueued = k;
    bottleneck.push(k - lastQueued <= holdFrames);
  });
  let peakQueue = 0;
  let peakQueueT = 0;
  sim.nearBridgeQueued.forEach((q, k) => {
    if (q > peakQueue) {
      peakQueue = q;
      peakQueueT = k * SIM_DT;
    }
  });
  const firstBottleneck = bottleneck.indexOf(true);
  const lastBottleneck = bottleneck.lastIndexOf(true);
  const bottleneckStart = firstBottleneck >= 0 ? firstBottleneck * SIM_DT : Infinity;
  const queueClears =
    lastBottleneck >= 0 && lastBottleneck < sim.frames - 1
      ? (lastBottleneck + 1) * SIM_DT
      : Infinity;
  const civIdx = civilians.filter((c) => c.riders.length > 0).map((c) => c.vehicle);
  const lastCivArrival = Math.max(...civIdx.map((i) => sim.arrival[i]));
  const ordered = households
    .map((h) => ({ id: h.id, t: orderTime.get(h.id)! }))
    .sort((a, b) => a.t - b.t);
  const firstOrder = ordered[0].t;
  const firstEngineStaged = Math.min(...engineIdx.map((i) => sim.arrival[i]));

  // ---- Phases ------------------------------------------------------------------------------
  const clampT = (t: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, Number.isFinite(t) ? t : hi));
  const bEvac = clampT(firstOrder, 9, 30);
  const bCong = clampT(Math.max(bottleneckStart, CONGESTION_PHASE_MIN_S), bEvac + 4, 60);
  const bResp = clampT(firstEngineStaged, bCong + 4, 72);
  const bResol = clampT(Math.max(heldFrom + 4, 75), bResp + 4, 84);
  const phases: Phase[] = [
    { id: "ignition", label: "Ignition", start: 0, end: 8 },
    { id: "spread", label: "Fire spread", start: 8, end: bEvac },
    { id: "evacuation", label: "Evacuation orders", start: bEvac, end: bCong },
    { id: "congestion", label: "Bridge congestion", start: bCong, end: bResp },
    { id: "response", label: "Crew response", start: bResp, end: bResol },
    { id: "resolution", label: "Resolution", start: bResol, end: duration },
  ];
  const phaseAt = (t: number): PhaseId => {
    for (let k = phases.length - 1; k >= 0; k--) if (t >= phases[k].start) return phases[k].id;
    return "ignition";
  };

  // ---- Captions ----------------------------------------------------------------------------
  const events: { t: number; text: string }[] = [
    { t: 0, text: `A small fire starts in the forest above ${TOWN}; wind ${world.wind.label}.` },
    { t: 8, text: "Pushed by the wind, the fire runs south-southeast toward Ridge Lane." },
    { t: closeTime, text: "Ridge Lane is closed as the fire edge approaches." },
    {
      t: ENGINE_DEPART_S[0],
      text: `${world.station.label} sends ${ENGINE_NAMES.slice(0, -1).join(", ")} and ${ENGINE_NAMES[ENGINE_NAMES.length - 1]} to the fire.`,
    },
  ];
  WAVES.forEach((w, k) => {
    const times = households.filter((h) => waveOf(h) === k).map((h) => orderTime.get(h.id)!);
    if (times.length) events.push({ t: Math.min(...times), text: w.caption });
  });
  if (Number.isFinite(bottleneckStart)) {
    events.push({
      t: bottleneckStart,
      text: `Traffic backs up at ${BRIDGE_NAME} — the only crossing to the shelter.`,
    });
  }
  if (peakQueue >= BOTTLENECK_MIN_QUEUE) {
    events.push({
      t: peakQueueT,
      text: `The bridge queue peaks at ${peakQueue} cars, crossing one at a time.`,
    });
  }
  engineIdx.forEach((i, k) => {
    if (sprayStart[k] <= duration) {
      events.push({
        t: sprayStart[k],
        text: `${ENGINE_NAMES[k]} arrives at ${placeName(engineStagings[k].label)} and starts water.`,
      });
    }
  });
  if (Number.isFinite(heldFrom) && heldFrom <= duration) {
    events.push({
      t: heldFrom + 1,
      text: "Crews hold the fire's edge above Ridge Lane and along the west flank.",
    });
  }
  if (queueClears <= duration) {
    events.push({
      t: queueClears,
      text: `The queue at ${BRIDGE_NAME} clears; the last cars roll across.`,
    });
  }
  const shelteredBy = (t: number) =>
    residents.reduce((n, r) => n + (arrivalFrame[r.vehicle] <= frameOf(t) ? 1 : 0), 0);
  const finalEvent = { t: Math.min(Math.max(lastCivArrival, 82), duration - 3), text: "" };
  events.push(finalEvent);
  events.sort((a, b) => a.t - b.t);
  for (let k = 1; k < events.length; k++) {
    events[k].t = Math.max(events[k].t, events[k - 1].t + CAPTION_MIN_GAP_S);
  }
  // The closing line reports the count at the moment it is shown.
  const finalCount = shelteredBy(finalEvent.t);
  finalEvent.text =
    finalCount === population
      ? `All ${population} residents are safe at ${world.shelter.label}; crews hold the line.`
      : `${finalCount} of ${population} residents are safe at ${world.shelter.label}; the last cars are arriving.`;
  const captions = events.filter((e) => e.t < duration);
  const captionAt = (t: number) => {
    let text = captions[0].text;
    for (const e of captions) if (e.t <= t) text = e.text;
    return text;
  };

  // ---- Sampling ----------------------------------------------------------------------------
  const ridersByVehicle = new Map<number, Resident[]>();
  for (const r of residents) {
    const list = ridersByVehicle.get(r.vehicle) ?? [];
    list.push(r);
    ridersByVehicle.set(r.vehicle, list);
  }
  const lerpAngle = (a: number, b: number, f: number) =>
    a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * f;
  const cellArea = fire.cellSize * fire.cellSize;

  const sample = (tIn: number): SimSnapshot => {
    const t = Math.min(duration, Math.max(0, Number.isFinite(tIn) ? tIn : 0));
    const k0 = frameOf(t);
    const k1 = Math.min(sim.frames - 1, k0 + 1);
    const a = Math.min(1, Math.max(0, t / SIM_DT - k0));
    const n = sim.n;
    const vehicles: VehicleState[] = [];
    const crews: CrewState[] = [];
    let queued = 0;
    let crewsDeployed = 0;
    for (let i = 0; i < n; i++) {
      const f0 = k0 * n + i;
      const f1 = k1 * n + i;
      const plan = plans[i];
      const status = statusAt(sim.status[f0]);
      const state: VehicleState = {
        id: plan.id,
        kind: plan.kind,
        p: {
          x: sim.x[f0] + (sim.x[f1] - sim.x[f0]) * a,
          z: sim.z[f0] + (sim.z[f1] - sim.z[f0]) * a,
        },
        heading: lerpAngle(sim.heading[f0], sim.heading[f1], a),
        speed: sim.speed[f0] + (sim.speed[f1] - sim.speed[f0]) * a,
        status,
        occupants: 0,
        visible: true,
      };
      if (plan.kind === "civilian") {
        const info = civilians[i];
        state.householdId = info.household.id;
        if (status === "sheltered") {
          if ((slotOfVehicle.get(i) ?? 0) >= overflowFrom) state.visible = false;
        } else {
          for (const r of ridersByVehicle.get(i) ?? []) if (r.walkEnd <= t) state.occupants++;
        }
        if (status === "queued") queued++;
      } else {
        const k = i - engineStart;
        state.stagingId = engineStagings[k].id;
        state.occupants = ENGINE.crew;
        if (status === "staged") {
          crewsDeployed++;
          const staging = engineStagings[k];
          crews.push({
            engineId: plan.id,
            stagingId: staging.id,
            spraying: t >= sprayStart[k],
            from: staging.p,
            target: staging.target,
          });
        }
      }
      vehicles.push(state);
    }

    const pedestrians: PedestrianState[] = [];
    let atHome = 0;
    let walking = 0;
    let inVehicles = 0;
    let sheltered = 0;
    let evacuating = 0;
    for (const r of residents) {
      const isSheltered = arrivalFrame[r.vehicle] <= k0;
      if (isSheltered) sheltered++;
      else if (t >= r.walkEnd) inVehicles++;
      else if (t >= r.walkStart) {
        walking++;
        const f = (t - r.walkStart) / (r.walkEnd - r.walkStart);
        pedestrians.push({
          id: r.id,
          householdId: r.householdId,
          p: { x: r.from.x + (r.to.x - r.from.x) * f, z: r.from.z + (r.to.z - r.from.z) * f },
          heading: Math.atan2(r.to.x - r.from.x, r.to.z - r.from.z),
        });
      } else atHome++;
      if (!isSheltered && orderTime.get(r.householdId)! <= t) evacuating++;
    }
    const counters: Counters = {
      population,
      atHome,
      walking,
      inVehicles,
      sheltered,
      evacuating,
      vehiclesQueued: queued,
      crewsDeployed,
      crewsTotal: world.station.engines,
      burnedAreaM2: countIgnitedBy(fireBuild.sortedIgnitions, t) * cellArea,
    };
    const orderedHouseholdIds: string[] = [];
    for (const o of ordered) {
      if (o.t > t) break;
      orderedHouseholdIds.push(o.id);
    }
    return {
      t,
      phase: phaseAt(t),
      caption: captionAt(t),
      vehicles,
      pedestrians,
      crews,
      closedEdgeIds: closures.filter((c) => t >= c.t).map((c) => c.edgeId),
      orderedHouseholdIds,
      bottleneckActive: bottleneck[k0],
      counters,
    };
  };

  // ---- Invariant checks over every simulated frame -----------------------------------------
  for (let k = 0; k < sim.frames; k++) {
    const snap = sample(k * SIM_DT);
    const c = snap.counters;
    if (c.atHome + c.walking + c.inVehicles + c.sheltered !== c.population) {
      throw new Error(`Population not conserved at t=${snap.t.toFixed(2)}`);
    }
    const aboard = snap.vehicles.reduce(
      (sum, v) => sum + (v.kind === "civilian" && v.status !== "sheltered" ? v.occupants : 0),
      0,
    );
    if (aboard !== c.inVehicles)
      throw new Error(`Vehicle occupants disagree with counters at t=${snap.t.toFixed(2)}`);
    if (c.walking !== snap.pedestrians.length) throw new Error("Pedestrian count mismatch");
    if (c.sheltered > world.shelter.capacity)
      throw new Error(`${world.shelter.label} over capacity`);
  }

  // ---- Describe and recap ------------------------------------------------------------------
  const engineName = (id: string) =>
    ENGINE_NAMES[plans.findIndex((p) => p.id === id) - engineStart] ?? id;
  const kmh = (v: number) => `${Math.round(v * 3.6)} km/h`;
  const bridgeNode = net.nodePos.get(bridgeEdge.from)!;
  const queuedSoFar = (i: number, t: number) => {
    let total = 0;
    const k0 = frameOf(t);
    for (let k = 1; k <= k0; k++)
      if (statusAt(sim.status[k * sim.n + i]) === "queued") total += SIM_DT;
    return total;
  };

  const describe = (target: PickTarget, snap: SimSnapshot): { title: string; lines: string[] } => {
    const k0 = frameOf(snap.t);
    if (target.kind === "vehicle") {
      const idx = plans.findIndex((p) => p.id === target.id);
      const vs = snap.vehicles.find((v) => v.id === target.id);
      if (idx < 0 || !vs) return { title: "Vehicle", lines: ["Not in this scenario"] };
      if (vs.kind === "engine") {
        const k = idx - engineStart;
        const staging = engineStagings[k];
        const lines =
          vs.status === "at-station"
            ? [`At ${world.station.label}`, `Assigned to ${placeName(staging.label)}`]
            : vs.status === "responding"
              ? [
                  `Responding to ${placeName(staging.label)}`,
                  `${ENGINE.crew} crew · ${kmh(vs.speed)}`,
                ]
              : [
                  `Staged at ${placeName(staging.label)} · ${snap.t >= sprayStart[k] ? "applying water" : "laying hose"}`,
                ];
        return { title: engineName(vs.id), lines };
      }
      const info = civilians[idx];
      const carried = (ridersByVehicle.get(idx) ?? []).length;
      if (info.riders.length === 0) {
        return {
          title: "Household car · left at home",
          lines: ["This household rode with neighbours"],
        };
      }
      const together = info.riders.length > 1 ? " · neighbours aboard" : "";
      switch (vs.status) {
        case "parked":
          return { title: "Household car · parked", lines: ["Residents at home"] };
        case "boarding":
          return {
            title: `Household car · ${vs.occupants} aboard`,
            lines: [`Boarding ${vs.occupants} of ${carried}${together}`],
          };
        case "queued": {
          const nearBridge = dist(vs.p, bridgeNode) < 170;
          return {
            title: `Household car · ${vs.occupants} aboard`,
            lines: [
              nearBridge ? `Queued for ${BRIDGE_NAME}` : "Stopped in traffic",
              `Waited ${fmtS(queuedSoFar(idx, snap.t))} so far`,
            ],
          };
        }
        case "driving":
          return {
            title: `Household car · ${vs.occupants} aboard`,
            lines: [`Driving to ${world.shelter.label} · ${kmh(vs.speed)}`],
          };
        default:
          return {
            title: "Household car · at shelter",
            lines: [`${carried} residents checked in at ${world.shelter.label}`],
          };
      }
    }
    if (target.kind === "shelter") {
      const carsIn = civIdx.filter((i) => arrivalFrame[i] <= k0).length;
      return {
        title: world.shelter.label,
        lines: [
          `${snap.counters.sheltered} of ${world.shelter.capacity} places filled`,
          `${carsIn} of ${civIdx.length} evacuating cars arrived`,
        ],
      };
    }
    if (target.kind === "station") {
      const out = snap.vehicles.filter(
        (v) => v.kind === "engine" && v.status !== "at-station",
      ).length;
      return {
        title: world.station.label,
        lines: [`${out} engines out · ${world.station.engines - out} in quarters`],
      };
    }
    const crossed = sim.bridgeEntries.filter((e) => e <= snap.t).length;
    const nearQueued = sim.nearBridgeQueued[k0];
    return {
      title: BRIDGE_NAME,
      lines: [
        "Single lane · only crossing to the shelter",
        `${nearQueued} cars queued · ${crossed} crossed so far`,
        `Metered to one car every ${BRIDGE_INTERVAL_S} s`,
      ],
    };
  };

  const end = sample(duration);
  const longestWait = Math.max(0, ...civIdx.map((i) => sim.queuedTime[i]));
  const recap: RecapItem[] = [
    { label: "Residents sheltered", value: `${end.counters.sheltered} of ${population}` },
    {
      label: "Peak queue at Mill Creek Bridge",
      value: peakQueue > 0 ? `${peakQueue} cars at ${fmtS(peakQueueT)}` : "No queue",
    },
    { label: "Longest wait in traffic", value: fmtS(longestWait) },
    {
      label: "Fire crews deployed",
      value: `${end.counters.crewsDeployed} of ${world.station.engines} engines`,
    },
    { label: "Area burned", value: `${(end.counters.burnedAreaM2 / 10000).toFixed(2)} ha` },
    { label: "Ridge Lane closed", value: `at ${fmtS(closeTime)}` },
  ];

  return { duration, phases, fire, sample, describe, recap };
}
