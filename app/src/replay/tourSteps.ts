import type { ReferencePlace } from "./places";
import { localTime } from "./timeline";
import type { TourStep } from "./Tour";
import type { ReplayModel } from "./types";

const STORAGE_PREFIX = "crisistwin.tour.";
const STORAGE_VERSION = "v1";

function key(kind: string): string {
  return `${STORAGE_PREFIX}${kind}.${STORAGE_VERSION}`;
}

/** Whether the tour has been completed or skipped; storage may be unavailable. */
export function tourSeen(kind: string): boolean {
  try {
    return window.localStorage.getItem(key(kind)) === "done";
  } catch {
    return false;
  }
}

export function markTourSeen(kind: string): void {
  try {
    window.localStorage.setItem(key(kind), "done");
  } catch {
    // Private mode or blocked storage: the tour simply shows again next time.
  }
}

interface TourFacts {
  name: string;
  /** Where the roads are, e.g. "Superior and Louisville, Boulder County, Colorado". */
  area: string;
  /** What captions measure fire distance from. */
  place: string;
  year: string;
  dateLabel: string;
  introAt: string;
  trafficAt: string;
  fireAt: string;
  fireBody: string;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Everything the tours say about a fire, derived from its bundle (no per-fire text). */
function tourFacts(model: ReplayModel, place: ReferencePlace | null): TourFacts {
  const tz = model.incident.timezone;
  const { startMs, endMs } = model.clock;
  const ignitionMs = model.fireSimulated?.ignition?.atMs ?? null;
  const firstPerimeterMs = model.perimeters[0]?.atMs ?? null;
  const anchor = ignitionMs ?? startMs;
  const horizon = firstPerimeterMs ?? Math.min(endMs, anchor + 6 * 3_600_000);
  const at = (fraction: number) => iso(Math.min(endMs, anchor + (horizon - anchor) * fraction));
  const year = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric" }).format(startMs);
  const dateLabel = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(ignitionMs ?? startMs);
  const fireBody = model.fireSimulated
    ? firstPerimeterMs !== null
      ? `Orange is the fire: a model until the satellite perimeter at ${localTime(firstPerimeterMs, tz)}, then the dashed blue-grey line.`
      : "Orange is the fire, from a fire-spread model; this bundle has no satellite perimeter to compare it with."
    : "The dashed blue-grey line is the satellite fire perimeter in effect at this time.";
  return {
    name: model.incident.name,
    area:
      model.incident.place ??
      (place && place.name !== "the population centre" ? place.name : "the affected area"),
    place: place?.name ?? "the population centre",
    year,
    dateLabel,
    introAt: iso(
      Math.min(endMs, (ignitionMs ?? startMs) + (ignitionMs !== null ? 40 : 60) * 60_000),
    ),
    trafficAt: at(1 / 3),
    fireAt: at(1 / 2),
    fireBody,
  };
}

function shared(f: TourFacts) {
  const timeline: TourStep = {
    title: "Move through time",
    body: `Play, or drag to any time. Ticks mark ${f.year} alerts and road reports. Space plays and pauses.`,
    target: ".rp-dock",
  };
  const traffic: TourStep = {
    title: "People leaving",
    body: "Blue-green is traffic, thicker and darker where jammed. Dark dots are stopped cars; grey dashes are closed roads.",
    target: ".rp-map",
    seekTo: f.trafficAt,
  };
  const fire: TourStep = {
    title: "The fire",
    body: f.fireBody,
    target: ".rp-map",
    seekTo: f.fireAt,
  };
  return { timeline, traffic, fire };
}

export function replayTour(model: ReplayModel, place: ReferencePlace | null): TourStep[] {
  const f = tourFacts(model, place);
  const { timeline, traffic, fire } = shared(f);
  return [
    {
      title: `${f.name}, ${f.dateLabel}`,
      body: `The ${f.name}, replayed on the real roads of ${f.area}. Traffic and the early fire are modelled; alerts and road reports are ${f.year} records.`,
      target: null,
      seekTo: f.introAt,
    },
    {
      title: "What's happening now",
      body: `The time, the latest alert, and how far the fire is from ${f.place}.`,
      target: ".rp-caption",
    },
    fire,
    traffic,
    timeline,
    {
      title: "The numbers",
      body: "On the road, out safely, and stuck or in the fire area.",
      target: ".rp-calm",
    },
    {
      title: "What is real and what is modelled",
      body: "Labels say where each item comes from: REPORTED or RECONSTRUCTED is history, SIMULATED is the model. Details ▾ explains the whole view.",
      target: ".rp-statusline",
    },
    {
      title: "Go further",
      body: "Play the story for the key moments. Switch fires at the top left; What if… compares alternative plans.",
      target: ".rp-tabs",
    },
  ];
}

export function simulationTour(model: ReplayModel, place: ReferencePlace | null): TourStep[] {
  const f = tourFacts(model, place);
  const { timeline, traffic, fire } = shared(f);
  return [
    {
      title: "Agent simulation",
      body: `This is not a replay of ${f.year}. Modelled residents decide when to leave and modelled responders manage traffic, over the real roads of ${f.area}.`,
      target: null,
      seekTo: f.introAt,
    },
    {
      title: "What's happening now",
      body: "This line tells you what is happening at the current time in the simulation.",
      target: ".rp-caption",
    },
    fire,
    traffic,
    timeline,
    {
      title: "The numbers",
      body: "On the road, out safely, and stuck or near the fire. “More details” adds why residents left (an order, seeing fire, neighbours leaving).",
      target: ".rp-calm",
    },
    {
      title: `Simulated responders vs ${f.year}`,
      body: `The Responders vs ${f.year} tab compares what the simulated responders did with what was reported in ${f.year}. Labels mark SIMULATED and REPORTED items.`,
      target: ".rp-tabs",
    },
  ];
}
