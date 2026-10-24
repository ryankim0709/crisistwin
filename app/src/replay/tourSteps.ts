import type { TourStep } from "./Tour";

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

const TIMELINE: TourStep = {
  title: "Move through time",
  body: "Press play, or drag to any time. Diamonds on the timeline are real 2018 alerts and road reports; Space plays and pauses, arrow keys step.",
  target: ".rp-dock",
};

const TRAFFIC: TourStep = {
  title: "People leaving",
  body: "Cyan dots are evacuating cars. Roads turn violet when jammed and grey dashed when closed.",
  target: ".rp-map",
  seekTo: "2018-11-08T16:30:00Z",
};

const FIRE: TourStep = {
  title: "The fire",
  body: "Orange is the fire. The glowing edge is where it is spreading. Until the first satellite image at 12:00 this is a model; after that the dashed white line is the satellite estimate.",
  target: ".rp-map",
  seekTo: "2018-11-08T17:30:00Z",
};

export const REPLAY_TOUR: TourStep[] = [
  {
    title: "Camp Fire, 8 Nov 2018",
    body: "This is the Camp Fire replayed over the real roads of Paradise, California. Fire and evacuation traffic are modelled; alerts and road reports are from 2018 records.",
    target: null,
    seekTo: "2018-11-08T15:00:00Z",
  },
  {
    title: "What's happening now",
    body: "This line tells you what is happening at the current time: the latest alert, cars on the road and how far the fire is from Paradise.",
    target: ".rp-caption",
  },
  FIRE,
  TRAFFIC,
  TIMELINE,
  {
    title: "The numbers",
    body: "How many people are on the road, how many are out safely, and how many are stuck or near the fire. Open “More details” for everything else.",
    target: ".rp-calm",
  },
  {
    title: "What is real and what is modelled",
    body: "Labels tell you where each item comes from: REPORTED or RECONSTRUCTED are historical, SIMULATED is model output, FIXTURE is a placeholder. The status line above the map says the same for the whole view.",
    target: ".rp-statusline",
  },
  {
    title: "Go further",
    body: "The What if… tab compares alternative plans, and the 3D buttons on the map show the same moment from a helicopter or a driver's seat. Reopen this tour any time with the Tour button.",
    target: ".rp-tabs",
  },
];

export const SIMULATION_TOUR: TourStep[] = [
  {
    title: "Agent simulation",
    body: "This is not a replay of 2018. Modelled residents decide when to leave and modelled responders manage traffic, over the real roads of Paradise.",
    target: null,
    seekTo: "2018-11-08T15:00:00Z",
  },
  {
    title: "What's happening now",
    body: "This line tells you what is happening at the current time in the simulation.",
    target: ".rp-caption",
  },
  FIRE,
  TRAFFIC,
  TIMELINE,
  {
    title: "The numbers",
    body: "On the road, out safely, and stuck or near the fire. “More details” adds why residents left (an order, seeing fire, neighbours leaving).",
    target: ".rp-calm",
  },
  {
    title: "Simulated responders vs 2018",
    body: "The Responders vs 2018 tab compares what the simulated responders did with what was reported in 2018. Labels mark SIMULATED and REPORTED items.",
    target: ".rp-tabs",
  },
];
