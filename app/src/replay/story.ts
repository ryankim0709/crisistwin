// Story mode: a short guided walk through the replay, built only from bundle data.
// Each chapter is anchored to a real bundle item (an event, a perimeter or a traffic frame)
// and carries that item's evidence class. Pure: no React, DOM or MapLibre here.
import { VARIANT_CAVEATS, featurable, type VariantIndex } from "./compare";
import { distanceM, inArea } from "./insights";
import { buildCaption, splitSnappedNote } from "./narrative";
import { POPULATION_CENTRE, type ReferencePlace } from "./places";
import { EVACUATION_AREA, baselineAt, hourIndexAt, type Mobility } from "./mobility";
import {
  clockParts,
  frameIndexAt,
  localTime,
  ignitionBasis,
  incidentYear,
  perimeterIndexAt,
  perimeterWindowEnd,
  simulatedFrontIndexAt,
} from "./timeline";
import type {
  AreaGeometry,
  EvidenceClass,
  LngLat,
  ReplayEvent,
  ReplayModel,
  TrafficMetrics,
  ZoneInsight,
} from "./types";

export interface Chapter {
  id: string;
  atMs: number;
  title: string;
  body: string;
  evidence: EvidenceClass;
  /** Coordinates the camera frames for this chapter; empty keeps the current view. */
  focus: LngLat[];
  /** What the chapter is about, kept highlighted on the map while the chapter is current. */
  spot: Spotlight;
  /** What followed or why it matters, each line with its own evidence class. */
  then?: ChapterNote[];
  /** Lead-in lines shown above the title: what happened since the previous chapter (time skips). */
  lead?: ChapterNote[];
  /** The closing what-if comparison instead of a moment on the clock. */
  reveal?: boolean;
}

export interface ChapterNote {
  text: string;
  evidence: EvidenceClass;
  /** Record a forward link points at; the note is dropped when another chapter tells that record. */
  refId?: string;
}

/** Map highlight for a chapter: marked places, road lines and outlined areas, plus a tag. */
export interface Spotlight {
  points: LngLat[];
  lines: LngLat[][];
  areas: AreaGeometry[];
  /** Short map tag at `anchor`, e.g. "ORDERED OUT". */
  label: string;
  anchor: LngLat | null;
}

/** Spotlight builder; the tag sits on the first point, else the middle of the first line or area. */
function spot(
  label: string,
  { points = [], lines = [], areas = [] }: Partial<Pick<Spotlight, "points" | "lines" | "areas">>,
): Spotlight {
  const line = lines.find((l) => l.length > 0);
  const ring = areas.length > 0 ? ringCoords(areas[0]) : [];
  const anchor =
    points[0] ?? (line ? line[Math.floor(line.length / 2)] : null) ?? (ring.length > 0 ? centre(ring) : null);
  return { points, lines, areas, label, anchor };
}

function spotCoords(s: Spotlight): LngLat[] {
  return [...s.points, ...s.lines.flat(), ...s.areas.flatMap((a) => ringCoords(a))];
}

/**
 * Camera target for a chapter: its focus coordinates, mirrored about the centre of its
 * spotlight so a fit puts the spotlit subject in the middle of the view. Chapters without a
 * spotlight frame their focus as is.
 */
export function chapterFrame(ch: Chapter): LngLat[] {
  const subject = spotCoords(ch.spot);
  if (subject.length === 0 || ch.focus.length === 0) return ch.focus;
  const [cx, cy] = centre(subject);
  return [...ch.focus, ...subject].flatMap(([x, y]): LngLat[] => [
    [x, y],
    [2 * cx - x, 2 * cy - y],
  ]);
}

function centre(coords: LngLat[]): LngLat {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of coords) {
    w = Math.min(w, x);
    s = Math.min(s, y);
    e = Math.max(e, x);
    n = Math.max(n, y);
  }
  return [(w + e) / 2, (s + n) / 2];
}

export interface RevealRow {
  id: string;
  title: string;
  question: string;
  /** Combined exposure (road + home) as a percentage of the baseline run's. */
  exposurePct: number;
  /** Vehicles arrived by 18:00 UTC (arrived_by_1800z_veh), when the index has it. */
  arrivedBaseline: number | null;
  arrivedVariant: number | null;
}

const HISTORICAL = new Set<EvidenceClass>(["observed", "reported", "reconstructed", "derived"]);
const MAX_FOCUS_EDGES = 150;
/** Modelled-vehicle chapters are skipped when their headline number is this small. */
const MIN_HEADLINE_VEH = 100;

function ringCoords(g: AreaGeometry): LngLat[] {
  return g.type === "Polygon" ? g.coordinates[0] : g.coordinates.flatMap((poly) => poly[0]);
}

function edgeCoordLookup(model: ReplayModel): Map<string, LngLat[]> {
  return new Map((model.roads?.items ?? []).map((e) => [e.id, e.coords]));
}

function eventLines(event: ReplayEvent, roads: Map<string, LngLat[]>): LngLat[][] {
  return event.edgeIds.flatMap((id) => {
    const coords = roads.get(id);
    return coords && coords.length > 0 ? [coords] : [];
  });
}

/** Fire area in effect at t: the observed perimeter if any, else the simulated front. */
function fireAt(model: ReplayModel, t: number): AreaGeometry | null {
  const p = perimeterIndexAt(model, t);
  if (p >= 0) return model.perimeters[p].geometry;
  const s = simulatedFrontIndexAt(model, t);
  return s >= 0 && model.fireSimulated ? model.fireSimulated.fronts[s].geometry : null;
}

function fireCoords(model: ReplayModel, t: number): LngLat[] {
  const g = fireAt(model, t);
  return g ? ringCoords(g) : [];
}

/** Below this modelled mean speed an edge counts as jammed for framing the camera. */
const JAM_KPH = 15;

/**
 * Coordinates of the edges carrying the most modelled vehicles at frame k, optionally only
 * inside `area` and/or only jammed ones.
 */
function busyEdgeLines(
  model: ReplayModel,
  k: number,
  area: AreaGeometry | null,
  jammedOnly = false,
  near: { coord: LngLat; m: number } | null = null,
): LngLat[][] {
  const traffic = model.traffic;
  if (!traffic || k < 0) return [];
  const roads = edgeCoordLookup(model);
  const out: LngLat[][] = [];
  let taken = 0;
  const edges = [...traffic.frames[k].edges].sort((a, b) => b[1] - a[1]);
  for (const [index, veh, speed] of edges) {
    if (veh <= 0 || taken >= MAX_FOCUS_EDGES) break;
    if (jammedOnly && speed >= JAM_KPH) continue;
    const coords = roads.get(traffic.edgeIds[index]);
    if (!coords || coords.length === 0) continue;
    const mid = coords[Math.floor(coords.length / 2)];
    if (area && !inArea(area, mid)) continue;
    if (near && distanceM(near.coord, mid) > near.m) continue;
    out.push(coords);
    taken += 1;
  }
  return out;
}

/** Hours after ignition before the device-data window may start, and its length. */
const MOBILITY_WINDOW_START_H = 2;
const MOBILITY_WINDOW_H = 8;
/** Only a strong drop makes a chapter: visits at most this share of the baseline. */
const MOBILITY_MAX_RATIO = 0.5;
/** Windows with less than this share of the busiest window's baseline (night hours) are not compared. */
const MOBILITY_MIN_BASELINE_SHARE = 0.5;
const MOBILITY_MAX_POINTS = 40;

/**
 * Device-data beat: the 8-hour window inside the replay (from two hours after ignition) where
 * visits to places in the sidecar's evacuation area fall furthest below the same hours of the
 * baseline week. Null when the sidecar, the series or a clear drop is missing.
 */
function mobilityChapter(ctx: StoryContext, m: Mobility | null): Chapter | null {
  const model = ctx.model;
  const ignitionMs = model.fireSimulated?.ignition?.atMs ?? model.clock.startMs;
  if (!m) return null;
  const series = m.series.find((s) => s.region === EVACUATION_AREA && s.category === "all");
  if (!series) return null;
  const first = hourIndexAt(m, ignitionMs + MOBILITY_WINDOW_START_H * 3_600_000);
  if (first < 0) return null;
  const windows: { i0: number; visits: number; normal: number }[] = [];
  for (let i0 = first; i0 + MOBILITY_WINDOW_H <= m.hourStartsMs.length; i0 += 1) {
    if (m.hourStartsMs[i0 + MOBILITY_WINDOW_H - 1] + 3_600_000 > model.clock.endMs) break;
    let visits = 0;
    let normal = 0;
    for (let i = i0; i < i0 + MOBILITY_WINDOW_H; i += 1) {
      visits += series.visits[i];
      normal += baselineAt(series.baseline, i);
    }
    windows.push({ i0, visits, normal });
  }
  const busiest = Math.max(0, ...windows.map((w) => w.normal));
  const best = windows
    .filter((w) => w.normal > 0 && w.normal >= busiest * MOBILITY_MIN_BASELINE_SHARE)
    .sort((a, b) => a.visits / a.normal - b.visits / b.normal)[0];
  if (!best || best.visits / best.normal > MOBILITY_MAX_RATIO) return null;
  const ratio = best.visits / best.normal;
  const startMs = m.hourStartsMs[best.i0];
  const endMs = m.hourStartsMs[best.i0 + MOBILITY_WINDOW_H - 1] + 3_600_000;
  const region = m.regions[EVACUATION_AREA];
  const warnedToo = m.notes.some((n) => /\bwarning/i.test(n));
  const points = m.cells.items
    .filter((c) => c.inEvacuationArea)
    .sort((a, b) => b.poiCount - a.poiCount)
    .slice(0, MOBILITY_MAX_POINTS)
    .map((c) => c.center);
  return {
    id: "mobility",
    // Told at the end of the window, once all of its hours are on the clock.
    atMs: endMs,
    title: ratio <= 0.25 ? "Visits to local places almost stop" : "Visits to local places drop sharply",
    body:
      `Between ${clock(ctx, startMs, endMs)} and ${clock(ctx, endMs, endMs)}, visits to ${fmt(series.poiCount)} local businesses and places in the ` +
      `phone-data area were ${Math.round(ratio * 100)}% of the same hours in the baseline week` +
      (m.baselineWeeks[0] ? ` (week of ${m.baselineWeeks[0]})` : "") +
      "." +
      (region?.label ? ` The area is ${lowerFirst(sentence(region.label, false))}${warnedToo ? ", including areas that were only warned" : ""}.` : "") +
      " From anonymous phone-location data (Advan, via Dewey); it counts visits to places, not people present.",
    evidence: m.evidenceClass,
    focus: points,
    spot: spot(points.length > 0 ? "PHONE-DATA AREA" : "", { points }),
  };
}

/** Ensure a closing full stop, unless `close` is false (then strip one). */
function sentence(text: string, close = true): string {
  const trimmed = text.trim().replace(/[.]+$/, "");
  return close ? `${trimmed}.` : trimmed;
}

/** Abbreviations whose full stop does not end a sentence ("Malibu Cyn Rd. and …"). */
const ABBREVIATION = /\b(?:Rd|St|Ave|Blvd|Dr|Ln|Cyn|Mt|Hwy|No|Jr|[A-Z])\.$/;

/** Upper-case the first letter of the text and of each sentence in it. */
function capitalise(text: string): string {
  return text.replace(/(^|[.!?]\s+)([a-z])/g, (m: string, p: string, c: string, at: number) =>
    at > 0 && ABBREVIATION.test(text.slice(0, at + 1)) ? m : p + c.toUpperCase(),
  );
}

function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
}

/** "a", "a and b", "a, b and c"; "a, b and c, and d" when an item has its own "and". */
function joinAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  const nested = items.some((x) => / and /.test(x));
  return `${items.slice(0, -1).join(", ")}${nested ? "," : ""} and ${items[items.length - 1]}`;
}

/** NIST fire observations seen in the half hour before t, for framing the camera. */
function observationCoords(model: ReplayModel, t: number, beforeMs = 30 * 60_000, afterMs = 0): LngLat[] {
  return (model.fireObservations?.items ?? [])
    .filter((o) => o.atMs <= t + afterMs && o.atMs > t - beforeMs)
    .map((o) => o.coord);
}

function argmax(values: number[]): number {
  let best = -1;
  for (let i = 0; i < values.length; i += 1) if (best < 0 || values[i] > values[best]) best = i;
  return best;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function firstEvent(model: ReplayModel, test: (e: ReplayEvent) => boolean): ReplayEvent | null {
  return model.events.find(test) ?? null;
}

function isOrder(e: ReplayEvent): boolean {
  return (
    HISTORICAL.has(e.evidenceClass) &&
    (e.type === "evacuation_order" || e.type === "alert_sent") &&
    /\border\b/i.test(e.label) &&
    !isCrosswalk(e)
  );
}

/** "3 minutes", "1 hour 5 minutes", "2 days 10 hours". */
function duration(ms: number): string {
  const min = Math.round(Math.abs(ms) / 60_000);
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (d >= 2) return h === 0 ? part(d, "day") : `${part(d, "day")} ${part(h, "hour")}`;
  const hours = d * 24 + h;
  if (hours === 0) return part(m, "minute");
  return m === 0 ? part(hours, "hour") : `${part(hours, "hour")} ${part(m, "minute")}`;
}

/** Duration between two times as the clock shows them (whole minutes), so 11:23 to 11:47 reads 24 minutes. */
function span(fromMs: number, toMs: number): string {
  return duration((Math.floor(toMs / 60_000) - Math.floor(fromMs / 60_000)) * 60_000);
}

/**
 * Local clock time of the variant index's 18:00 UTC cut-off (arrived_by_1800z): 18:00 UTC on the
 * day of `fromMs`, or the next day when `fromMs` is already past it.
 */
export function cutoffClock(fromMs: number, tz: string): string {
  const d = new Date(fromMs);
  let cut = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 18);
  if (cut <= fromMs) cut += 24 * 3_600_000;
  return localTime(cut, tz).slice(0, 5);
}

/** The "everyone at once" what-if, when the index has it and it is not caveated away. */
function allAtOnceLine(variants: VariantIndex | null, firstOrderMs: number, tz: string): string | null {
  const v = variants?.variants.find((x) => x.id === "all-at-once");
  if (!v || !featurable(v.id)) return null;
  const h = v.headline.total_exposed_veh_min;
  if (!h || h.baseline == null || h.variant == null || h.baseline <= 0) return null;
  const pct = Math.round((1 - h.variant / h.baseline) * 100);
  if (pct <= 0) return null;
  const a = v.headline.arrived_by_1800z_veh;
  const b = v.headline.peak_blocked_veh;
  return (
    `What-if run: had every zone been ordered at ${localTime(firstOrderMs, tz)} instead of in waves, ` +
    `the car-minutes exposed to the modelled fire (on the road and at home) would have been ${pct}% lower` +
    (a?.baseline != null && a.variant != null
      ? `, and ${fmt(a.variant)} cars instead of ${fmt(a.baseline)} would have been out by ${cutoffClock(firstOrderMs, tz)}`
      : "") +
    (b?.baseline != null && b.variant != null && b.variant > b.baseline
      ? `, though the most cars stuck at once (counting cars that never clear) rises from ${fmt(b.baseline)} to ${fmt(b.variant)}`
      : "") +
    ". A hindsight experiment: it assumes everyone hears at once."
  );
}

// ---------------------------------------------------------------------------------------------
// Record text: labels rewritten into plain language by rule. No per-incident sentences here,
// only label patterns and a small acronym glossary.

/** Rewrites applied to every record label: structure, source tags and abbreviations. */
const PLAIN: [RegExp, string][] = [
  [/^(Evacuation (?:order|warning)): \1:\s*/i, "$1: "],
  [/^Alert alert:\s*/i, "Phone alert: "],
  [/^Everbridge alert:\s*(?:zones\s+)?/i, "Phone alert: "],
  [/\s*\(Everbridge launch areas[^)]*\)/gi, ""],
  [/\s*\((?:AAR|map layer|narrative|[\w ]*ODM post)\)/gi, ""],
  [/\s*\(Zone \d+ per Section \d+ narrative\)/gi, ""],
  [/\s*\(Census Designated Area\)/gi, ""],
  [/\s*\(derived from [^)]*\)/gi, ""],
  [/\s*\[(?:snapped|low confidence|unresolved)[^\]]*\]/gi, ""],
  [/\bEvacuation Order issued for\b/g, "Evacuation order for"],
  [/\bEvacuation Warning issued for\b/g, "Evacuation warning for"],
  [/\bIncident Commander requested\b/g, "the incident commander asked for"],
  [/\bIncident Commander\b/g, "the incident commander"],
  [/\bFire Command\b/g, "fire command"],
  [/\bEOC log:\s*/g, "Emergency operations centre log: "],
  [/\bEOC\b/g, "emergency operations centre"],
  [/\bESF 8 Public Health\b/g, "the public health team"],
  [/\b((?:[A-Z][\w.]* )+)ECC\b/g, "the $1dispatch centre"],
  [/\bECC\b/g, "the dispatch centre"],
  [/\bPPD\b/g, "Paradise police"],
  [/\b([A-Z][a-z]+) PD\b/g, "$1 police"],
  [/\bFPD\b/g, "fire district"],
  [/\bCopter-\d+\b/g, "helicopter"],
  [/\bBranch \d+\b/g, "a fire command team"],
  [/\bSheriff IMT\b/g, "the sheriff's incident management team"],
  [/\bIMT\b/g, "incident management team"],
  [/\bPIO tweet:\s*/g, "Public information officer's post: "],
  [/\ban SCL hospital\b/g, "a hospital"],
  [/\bNB\b/g, "northbound"],
  [/\bSB\b/g, "southbound"],
  [/\bL\. /g, "Lower "],
  [/\bU\. /g, "Upper "],
  [/\bN\.? (?=[A-Z][a-z])/g, "North "],
  [/\bS\.? (?=[A-Z][a-z])/g, "South "],
  [/\.{2,}/g, "."],
  [/\bMccaslin\b/g, "McCaslin"],
  [/\ba line down\b/g, "a downed line"],
  [/\bAll of City of\b/gi, "All of the City of"],
  [/\bT\.?O\.? Blvd\b/g, "Thousand Oaks Blvd"],
  [/\bin a contraflow configuration\b/gi, "in contraflow"],
  [/\bcontraflow outbound only (.+?)\.?$/i, "contraflow on $1, outbound only"],
  // "CHP initiating contraflow …" is a log fragment; told as a sentence.
  [/^([A-Z][\w ()]*?) initiating\b/, "$1 began"],
];

/** Acronyms spelled out at their first appearance in the story (per term, first pattern that fits). */
const EXPLAIN: [string, RegExp, string][] = [
  ["CHP", /\bCHP\b/, "the California Highway Patrol (CHP)"],
  ["CodeRED", /\bA CodeRED phone alert\b/, "A phone alert from CodeRED, an emergency alert system,"],
  ["CodeRED", /\bCodeRED\b/, "CodeRED (an emergency alert system)"],
  // Model phrasing only ("of which 365 are stuck"), never a record's "is stuck at …".
  ["stuck", /\b(\d[\d,]*) (are|were) stuck\b/, "$1 $2 stuck in queues that cannot move"],
  ["PCH", /\bPCH\b/, "Pacific Coast Highway (PCH)"],
  ["SCE", /\bSCE\b/, "Southern California Edison (SCE)"],
  ["SWAT", /\bSWAT\b/, "SWAT (a special police team)"],
  ["CAL FIRE", /\bCAL FIRE\b/, "CAL FIRE (the state fire agency)"],
  ["contraflow", /\bcontraflow\b/i, "contraflow (both sides of the road carry traffic out)"],
];

function plain(label: string): string {
  let text = splitSnappedNote(label).text;
  for (const [re, to] of PLAIN) text = text.replace(re, to);
  return capitalise(text.replace(/\s{2,}/g, " ").trim());
}

/** Crosswalk duplicates ("… → N block groups (derived crosswalk …)") only lend their zones. */
function isCrosswalk(e: ReplayEvent): boolean {
  return /:bg$/.test(e.id) || /derived crosswalk/i.test(e.label);
}

/** An area a record names: "Paradise 14" is zone 14 of Paradise, keyed "#14". */
interface AreaName {
  key: string;
  /** Short form for titles and keys: the name up to its first comma or dash. */
  label: string;
  /** The whole name as the record gives it ("south of Highway 101, Ventura County to Malibu Canyon"). */
  full: string;
  prefix: string | null;
  num: string | null;
}

/** Where record labels name their areas, first match wins. */
const NAME_PATTERNS: RegExp[] = [
  /\):\s*(.+?)\s*→/,
  /asked for an evacuation (?:order|warning) for (.+?)\.*$/i,
  /CodeRED (?:order|warning) \((?:initial|recall) attempt\):\s*(.+)$/i,
  /fire observation in (.+?)\.*$/i,
  /^Evacuation (?:order|warning):\s*((?:Town|City|Community|Village|County) of [^:]+):/i,
  /^Evacuation (?:order|warning) for (.+?)\.?$/i,
  /^Phone alert:\s*(.+?)\.?$/i,
  /\b(?:evacuations?|orders?|warnings?)(?: ordered| issued| added)?,? (?:for|in) (?:the )?(.+?)\.?$/i,
  /^Evacuation (?:order|warning):\s*(.+?)(?:\s+under\b.*)?\.?$/i,
];
/** A captured "name" with one of these words is a sentence, not an area. */
const SENTENCE_WORDS =
  /\b(?:is|are|was|were|states?|issues?|announces?|asks?|requests?|begins?|ordered|needed|mandatory|voluntary|after|email)\b/i;
const ROAD_WORD = /\b(?:highway|hwy|road|rd|route|us|sr|ca|interstate)$/i;
/** A place word followed by one of these is a road or feature name ("Malibu Canyon Rd"). */
const ROAD_SUFFIX = /^\s+(?:rd|road|blvd|boulevard|ave|avenue|dr|drive|st|street|way|hwy|highway|pkwy|canyon|cyn|creek|lake)\b/i;

function areaName(raw: string): AreaName | null {
  const label = raw
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/\s*-?\s*\b(?:mandatory|voluntary) evacuation\b.*$/i, "")
    .replace(/^zones?\s+(?=[A-Za-z])/i, "")
    .replace(/[.\s]+$/, "")
    .trim();
  if (!label || SENTENCE_WORDS.test(label)) return null;
  // Descriptions read mid-sentence: "for all of City of Malibu", "for south of Highway 101".
  const midSentence = (s: string) =>
    s.replace(/^(?:All|Parts|From|Region|(?:North|South|East|West) of)\b/, (w) => w.toLowerCase());
  const short = midSentence(label.split(/\s+-\s+|,\s*/)[0].trim());
  const full = midSentence(label);
  const num = short.match(/^(?:(.*?)\s+)?(\d{1,2}[A-Za-z]?)$/);
  if (num && !(num[1] && ROAD_WORD.test(num[1]))) {
    const prefix = num[1] && !/^zones?$/i.test(num[1]) ? num[1] : null;
    return { key: `#${num[2].toLowerCase()}`, label: short, full, prefix, num: num[2] };
  }
  const key = short
    .toLowerCase()
    .replace(/^(?:all of |parts of )?(?:the )?(?:(?:city|town|community|village) of )?/, "")
    .trim();
  return key ? { key, label: short, full, prefix: null, num: null } : null;
}

/** Census names ("Block Group 2, Census Tract 16") are not area names a record could use. */
const CENSUS_NAME = /\bBlock Group\b|\bCensus Tract\b/i;

function parseNames(text: string): AreaName[] {
  for (const re of NAME_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    // "Paradise 3, Paradise 8" is a list; "south of Highway 101, Ventura County to …" is one area.
    const parts = m[1]
      .replace(/\s*\([^)]*\)/g, "")
      .split(/;\s*/)
      .flatMap((p) => {
        const pieces = p.split(/,\s+(?=[A-Z0-9])/);
        return pieces.every((x) => x.trim().split(/\s+/).length <= 3) ? pieces : [p];
      });
    // "From X to Y" names a stretch, told as "the area from X to Y".
    return parts
      .map((p) => p.trim().replace(/^from\s+/i, "the area from "))
      .map(areaName)
      .filter((n): n is AreaName => n !== null);
  }
  return [];
}

/** "Paradise zones 3 and 8, Lower Pentz and 2 more areas"; `full` keeps each name's whole extent. */
function formatNames(names: AreaName[], max = 5, full = false): string {
  const items: string[] = [];
  const groups = new Map<string, { at: number; prefix: string | null; nums: string[] }>();
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n.key)) continue;
    seen.add(n.key);
    if (n.num) {
      const g = (n.prefix ?? "").toLowerCase();
      const group = groups.get(g);
      if (group) group.nums.push(n.num);
      else {
        groups.set(g, { at: items.length, prefix: n.prefix, nums: [n.num] });
        items.push("");
      }
    } else items.push(full ? n.full : n.label);
  }
  for (const g of groups.values()) {
    items[g.at] = `${g.prefix ? `${g.prefix} ` : ""}zone${g.nums.length > 1 ? "s" : ""} ${joinAnd(g.nums)}`;
  }
  if (items.length > max) {
    return joinAnd([...items.slice(0, max - 1), `${items.length - max + 1} more areas`]);
  }
  return joinAnd(items);
}

function nameCount(names: AreaName[]): number {
  return new Set(names.map((n) => n.key)).size;
}

/** Strip a leading "Evacuation order:" style tag from a record sentence. */
function stripTag(text: string): string {
  return capitalise(text.replace(/^(?:Evacuation (?:order|warning)|Phone alert):\s*/i, ""));
}

type Family = "order" | "warning" | "alert" | "road" | "fire" | "other";

const FAMILY: Record<string, Family> = {
  evacuation_order: "order",
  evacuation_requested: "order",
  evacuation_order_downgraded: "order",
  evacuation_warning: "warning",
  alert_sent: "alert",
  contraflow_started: "road",
  road_closed: "road",
  road_reopened: "road",
  road_blocked: "road",
  capacity_changed: "road",
  traffic_control_reported: "road",
  fire_arrival: "fire",
  burnover: "fire",
  fire_status_report: "fire",
};

/** Plain titles for record types whose labels are too long to be one. */
const TYPE_TITLE: Record<string, string> = {
  evacuation_started: "Evacuations start",
  evacuation_completed: "An evacuation is reported complete",
  facility_evacuated: "A facility evacuates",
  shelter_opened: "A new place to go",
  shelter_closed: "A shelter closes",
  shelter_full: "A shelter is full",
  shelter_in_place: "People shelter in place",
  civilian_fatality: "A civilian death is recorded",
  entrapment: "People trapped by the fire",
  infrastructure_failure: "Power and phones fail",
  fire_status_report: "A report from the fire",
  road_closed: "A road is closed",
  road_blocked: "A road is blocked",
  contraflow_started: "Lanes turned outbound",
  capacity_changed: "Police hold traffic",
  traffic_control_reported: "Police direct traffic",
};

/** Fire records that mark a jump in the fire's reach. */
const FIRE_JUMP =
  /\b(?:jumps?|cross(?:es|ed)?|crests?)\b|\b(?:reach(?:es|ed)?|extends? to) (?:the )?(?:ocean|homes)\b/i;

/** One historical record, normalised for the story. */
interface RecordRow {
  e: ReplayEvent;
  family: Family;
  /** Plain-language label. */
  text: string;
  names: AreaName[];
  keys: Set<string>;
  /** The record's zones plus those of its crosswalk duplicate. */
  zoneIds: string[];
  alertKind: "order" | "warning" | null;
  /** Every area it names had an order (for orders) or an alert (for alerts) before. */
  repeat: boolean;
  /** An order whose names were all ordered before, for new zones under the same name. */
  sameName: boolean;
  tier: number;
}

/** Records grouped into one story moment (an order wave, a run of fire sightings). */
interface Beat {
  atMs: number;
  rows: RecordRow[];
  tier: number;
}

/**
 * Largest gap (sim time) left between chapters inside the story's active window: the window's
 * length over GAP_DIVISOR, kept between MAX_GAP_MS and MAX_GAP_CAP_MS so a morning reads minute by
 * minute and a multi-day fire stays watchable.
 */
const MAX_GAP_MS = 20 * 60_000;
const MAX_GAP_CAP_MS = 100 * 60_000;
const GAP_DIVISOR = 18;
/** After the last modelled traffic peak the story thins out: gaps up to this share larger are left. */
const TAIL_GAP_FACTOR = 1.5;
/**
 * A gap with no record left in it, longer than STATUS_GAP_FACTOR times the limit, gets model status
 * beats, but only if at most MAX_STATUS_PER_GAP close it.
 */
const STATUS_GAP_FACTOR = 1.5;
const MAX_STATUS_PER_GAP = 3;
/** At most this many model status beats in a story. */
const MAX_STATUS = 6;
/** Beats sit at least this far from the chapters around them. */
const BEAT_MARGIN_MS = 3 * 60_000;
/** A gap-filling beat must leave no part of its gap longer than this share of it (unless it closes it). */
const SPLIT_SHARE = 0.8;
/** At most this many beats are added to the core chapters. */
const MAX_BEATS = 24;
/** A fire record this close to a decision (and naming no area) is told beside it. */
const ALONGSIDE_MS = 2 * 60_000;
/** Fire records this close to the one before (and within FIRE_RUN_MAX_MS of the first) are told as one beat. */
const FIRE_MERGE_MS = 5 * 60_000;
const FIRE_RUN_MAX_MS = 10 * 60_000;
/** Orders and warnings this close (a request wave and the dispatch order after it) are one beat. */
const DECISION_MERGE_MS = 3 * 60_000;
/** The window runs at most this far past the modelled traffic peaks. */
const WINDOW_TAIL_MS = 2 * 3_600_000;
/** A pause between decisions this long splits the record into separate episodes. */
const EPISODE_SPLIT_MS = 3 * 3_600_000;
/** A later episode with this many decision moments moves the window start to it. */
const DENSE_EPISODE_MIN = 8;
/** Record-to-record links (order, alert, sighting) further apart than this are not told. */
const LINK_MAX_MS = 8 * 3_600_000;
/** A warning's later order is looked up this far ahead (multi-day fires warn early). */
const WARNING_LINK_MS = 24 * 3_600_000;
/** Fire seen after an order is told only within this time. */
const FOLLOW_MS = 60 * 60_000;
/** Delays shorter than this read as "the same moment" and are not told as a delay. */
const MIN_DELAY_MS = 3 * 60_000;
/** Modelled lead times beyond this are not quoted (the model fire is too coarse for them). */
const MAX_LEAD_S = 6 * 3600;
/** This many zones reached by the model fire in the same minute look like an artifact. */
const TIE_ZONES = 3;
/** A chapter at least this long after the one before (and past the status-beat limit) gets a "time skip" note. */
const SKIP_NOTE_MS = 2 * 3_600_000;
/** Notes under a chapter (lead-in lines not counted). */
const MAX_NOTES = 4;
/** Must-tell records may sit this close to another chapter (the usual margin is BEAT_MARGIN_MS). */
const MUST_TELL_MARGIN_MS = 60_000;
/** Notes in the closing chapter. */
const EPILOGUE_NOTES = 7;
/** A "never reaches" claim needs the model fire to keep spreading this long after the order. */
const HORIZON_MS = MAX_LEAD_S * 1000;

/** Story-wide lookups over the record and the model, shared by every beat. */
interface StoryContext {
  model: ReplayModel;
  tz: string;
  place: ReferencePlace | null;
  roads: Map<string, LngLat[]>;
  rows: RecordRow[];
  /** Named area key -> zones, from crosswalks and single-area records. */
  keyZones: Map<string, Set<string>>;
  insights: Map<string, ZoneInsight>;
  ignitionMs: number | null;
  /** Time of the last simulated fire front; after it the model fire is held, not spreading. */
  lastFrontMs: number | null;
  /** The model front is clipped to the first satellite outline (so it cannot spread past it). */
  clippedToFirst: boolean;
  /** Per traffic frame: the fewest stuck cars from that frame to the end (stuck cars that never clear). */
  stuckFloor: number[];
}

function storyContext(model: ReplayModel, place: ReferencePlace | null): StoryContext {
  const byId = new Map(model.events.map((e) => [e.id, e]));
  const rows: RecordRow[] = [];
  for (const e of model.events) {
    if (!HISTORICAL.has(e.evidenceClass) || isCrosswalk(e)) continue;
    const family = FAMILY[e.type] ?? "other";
    const sibling = byId.get(`${e.id}:bg`);
    const text = plain(e.label);
    let names: AreaName[] = [];
    if (family === "fire") names = /fire observation in/i.test(text) ? parseNames(text) : [];
    else if (family === "order" || family === "warning" || family === "alert") {
      // A low-confidence crosswalk lends its zones, but the story keeps the record's own words.
      const lowConfidence = !!sibling && /derived crosswalk, low confidence\)/i.test(sibling.label);
      if (lowConfidence) names = parseNames(text);
      if (names.length === 0 && sibling) names = parseNames(plain(sibling.label));
      if (names.length === 0) names = parseNames(text);
    }
    rows.push({
      e,
      family,
      text,
      names,
      keys: new Set(names.map((n) => n.key)),
      zoneIds: [...new Set([...e.zoneIds, ...(sibling?.zoneIds ?? [])])],
      alertKind: /\border\b/i.test(e.label) ? "order" : /\bwarning\b/i.test(e.label) ? "warning" : null,
      repeat: false,
      sameName: false,
      tier: 0,
    });
  }
  // An alert logged in the same minute as an order for the same named area is that order's alert.
  for (const r of rows) {
    if (r.family !== "alert" || r.zoneIds.length > 0) continue;
    const pair = rows.filter(
      (o) =>
        (o.family === "order" || o.family === "warning") &&
        Math.abs(o.e.atMs - r.e.atMs) < 60_000 &&
        [...o.keys].some((k) => r.keys.has(k)),
    );
    r.zoneIds = [...new Set(pair.flatMap((o) => o.zoneIds))];
  }
  // "zones 2, 6" in one record and "Paradise 2" in another are the same zones.
  const prefixes = new Map<string, string>();
  for (const r of rows) for (const n of r.names) if (n.num && n.prefix && !prefixes.has(n.key)) prefixes.set(n.key, n.prefix);
  for (const r of rows) for (const n of r.names) if (n.num && !n.prefix) n.prefix = prefixes.get(n.key) ?? null;
  // Repeats and tiers, in clock order: a minute's records do not repeat each other.
  const ordered = new Set<string>();
  const orderedZones = new Set<string>();
  const alerted = new Set<string>();
  for (let i = 0; i < rows.length; ) {
    let j = i;
    while (j < rows.length && rows[j].e.atMs - rows[i].e.atMs < 60_000) j += 1;
    const minute = rows.slice(i, j);
    for (const r of minute) {
      // Areas with zones repeat by zone (one name can cover several launch areas), others by name.
      const seen = r.family === "order" ? ordered : r.family === "alert" ? alerted : null;
      r.repeat =
        r.family === "order" && r.zoneIds.length > 0
          ? r.zoneIds.every((z) => orderedZones.has(z))
          : seen !== null && r.keys.size > 0 && [...r.keys].every((k) => seen.has(k));
      r.sameName = r.family === "order" && !r.repeat && r.keys.size > 0 && [...r.keys].every((k) => ordered.has(k));
      r.tier = tierOf(r);
    }
    for (const r of minute) {
      if (r.family === "order") r.zoneIds.forEach((z) => orderedZones.add(z));
      if (r.family === "order") r.keys.forEach((k) => ordered.add(k));
      if (r.family === "alert") r.keys.forEach((k) => alerted.add(k));
    }
    i = j;
  }
  const keyZones = new Map<string, Set<string>>();
  const addKey = (key: string, ids: Iterable<string>) => {
    const set = keyZones.get(key) ?? new Set<string>();
    for (const id of ids) set.add(id);
    keyZones.set(key, set);
  };
  for (const r of rows) if (r.names.length === 1 && r.zoneIds.length > 0) addKey(r.names[0].key, r.zoneIds);
  // Model zone names count as area names only when whole: not Census names, and not a name the
  // key would cut short ("South of Highway 101, east of Reino Rd." is not "south of Highway 101").
  for (const z of model.zones?.items ?? []) {
    if (CENSUS_NAME.test(z.name)) continue;
    const n = areaName(z.name);
    if (n && n.full === n.label && !keyZones.has(n.key)) addKey(n.key, [z.id]);
  }
  const fronts = model.fireSimulated?.fronts ?? [];
  const metrics = model.traffic?.metrics ?? [];
  const stuckFloor = new Array<number>(metrics.length);
  for (let k = metrics.length - 1, low = Infinity; k >= 0; k -= 1) {
    low = Math.min(low, metrics[k].blockedVeh);
    stuckFloor[k] = low;
  }
  return {
    model,
    tz: model.incident.timezone,
    place,
    roads: edgeCoordLookup(model),
    rows,
    keyZones,
    insights: new Map((model.insights?.zones ?? []).map((z) => [z.zoneId, z])),
    ignitionMs: model.fireSimulated?.ignition?.atMs ?? null,
    lastFrontMs: fronts.length > 0 ? fronts[fronts.length - 1].atMs : null,
    clippedToFirst: /\bfirst satellite perimeter\b/i.test(model.fireSimulated?.constraintNote ?? ""),
    stuckFloor,
  };
}

/** Cars stuck at frame k that are still stuck at every later frame (they never get out in the model). */
function stuckForGood(ctx: StoryContext, k: number): number {
  return k >= 0 ? (ctx.stuckFloor[k] ?? 0) : 0;
}

/** First frame from which some stuck cars never clear, and how many there are at the end. */
function stuckResidue(ctx: StoryContext): { atMs: number; veh: number } | null {
  const metrics = ctx.model.traffic?.metrics ?? [];
  const veh = metrics.length > 0 ? metrics[metrics.length - 1].blockedVeh : 0;
  if (veh <= 0) return null;
  const k = ctx.stuckFloor.findIndex((x) => x >= Math.min(veh, MIN_HEADLINE_VEH));
  return k >= 0 ? { atMs: metrics[k].atMs, veh } : null;
}

/** Stuck cars at frame k, leaving out those that never clear (told once, as a model limitation). */
function clearingStuck(ctx: StoryContext, k: number, m: TrafficMetrics): number {
  return Math.max(0, m.blockedVeh - stuckForGood(ctx, k));
}

/** "N are on the road, of which M are stuck", leaving out stuck cars that never clear (told once, elsewhere). */
function roadParts(ctx: StoryContext, m: TrafficMetrics): string {
  const stuck = clearingStuck(ctx, frameIndexAt(ctx.model, m.atMs), m);
  if (m.enRouteVeh > 0 && stuck >= m.enRouteVeh) return `${fmt(m.enRouteVeh)} are on the road, all of them stuck`;
  return `${fmt(m.enRouteVeh)} are on the road${stuck > 0 ? `, of which ${fmt(stuck)} are stuck` : ""}`;
}

/** Event table a record comes from ("nist-tn2252:t11"), so records of two tables are not merged. */
function tableOf(e: ReplayEvent): string {
  return e.id.includes(":") ? e.id.split(":").slice(0, 2).join(":") : (e.sourceId ?? e.id);
}

/** Place a fire record names: its sightings' town, else a trailing "(Town)" tag; null when none. */
function placeOf(r: RecordRow): string | null {
  const n = r.names[0];
  if (r.e.type === "fire_arrival" && n) return n.prefix?.toLowerCase() ?? null;
  const tag = r.text.match(/\(([A-Z][\w .'-]+)\)\.?$/);
  return tag ? tag[1].toLowerCase() : null;
}

/** Lower is told first: orders with a mapped area, other decisions and fire jumps, alerts, fire, warnings, the rest. */
function tierOf(r: RecordRow): number {
  switch (r.family) {
    case "order":
      return r.repeat ? 2 : r.zoneIds.length > 0 ? 0 : 1;
    case "road":
      if (r.e.type === "road_blocked") return 3;
      return /\[unresolved/i.test(r.e.label) ? 4 : 1;
    case "alert":
      return 2;
    case "fire":
      if (FIRE_JUMP.test(r.text) && !/\bthreaten/i.test(r.text)) return 1;
      return r.e.type === "fire_status_report" ? 5 : 3;
    case "warning":
      return 4;
    default:
      if (r.e.type === "civilian_fatality" || r.e.type === "entrapment") return 3;
      return /^(?:evacuation_started|evacuation_completed|facility_evacuated)$/.test(r.e.type) ? 4 : 5;
  }
}

/** Records the gap filler may tell: dated to the minute, not repeats of an alert, not churn. */
function isCandidate(r: RecordRow): boolean {
  const e = r.e;
  if (["fire_ignition", "fire_reported", "perimeter_observed", "road_reopened"].includes(e.type)) return false;
  if (e.timePrecision === "day") return false;
  if (/recall attempt/i.test(e.label)) return false;
  return !/^Temporary refuge|^TRA-/i.test(e.label);
}

function groupOf(r: RecordRow): "decision" | "fire" | "other" {
  if (r.family === "fire" || r.e.type === "road_blocked") return "fire";
  return r.family === "other" ? "other" : "decision";
}

/**
 * The record a beat is told by: its lowest tier, except that a phone alert sent with an order or
 * warning in the same minute passes that decision on, so the decision leads.
 */
function topRow(beat: Beat): RecordRow {
  const top = beat.rows.find((r) => r.tier === beat.tier) ?? beat.rows[0];
  if (top.family !== "alert") return top;
  return (
    beat.rows.find(
      (r) => (r.family === "order" || r.family === "warning") && Math.abs(r.e.atMs - top.e.atMs) < 60_000,
    ) ?? top
  );
}

function clusterBeats(rows: RecordRow[]): Beat[] {
  const beats: Beat[] = [];
  const open = new Map<string, Beat>();
  for (const r of rows) {
    const g = groupOf(r);
    const last = open.get(g);
    const dt = last ? r.e.atMs - last.atMs : Infinity;
    // Fire records chain (each within FIRE_MERGE_MS of the one before) while they share a place.
    const prev = last?.rows[last.rows.length - 1];
    const here = placeOf(r);
    const samePlace = !!last && last.rows.every((o) => placeOf(o) === null || here === null || placeOf(o) === here);
    const join =
      last &&
      (g === "fire"
        ? samePlace && !!prev && r.e.atMs - prev.e.atMs <= FIRE_MERGE_MS && dt <= FIRE_RUN_MAX_MS
        : dt < 60_000 ||
          (g === "decision" &&
            dt <= DECISION_MERGE_MS &&
            (r.family === "order" || r.family === "warning") &&
            last.rows.every((o) => (o.family === "order" || o.family === "warning") && tableOf(o.e) === tableOf(r.e))));
    if (last && join) {
      last.rows.push(r);
      last.tier = Math.min(last.tier, r.tier);
    } else {
      const beat: Beat = { atMs: r.e.atMs, rows: [r], tier: r.tier };
      beats.push(beat);
      open.set(g, beat);
    }
  }
  return beats;
}

function clock(ctx: StoryContext, t: number, ref: number): string {
  const p = clockParts(t, ctx.tz);
  const time = p.time.slice(0, 5);
  if (p.date === clockParts(ref, ctx.tz).date) return time;
  const day = new Intl.DateTimeFormat("en-US", { timeZone: ctx.tz, month: "short", day: "numeric" }).format(t);
  return `${time} on ${day}`;
}

function zonesOfIds(ctx: StoryContext, ids: Iterable<string>) {
  const set = new Set(ids);
  return (ctx.model.zones?.items ?? []).filter((z) => set.has(z.id));
}

function zonesOf(ctx: StoryContext, ids: Iterable<string>): AreaGeometry[] {
  const set = new Set(ids);
  return (ctx.model.zones?.items ?? []).filter((z) => set.has(z.id)).map((z) => z.geometry);
}

/** Text keys (place names) a free-text label mentions, as a place and not as part of a road name. */
function mentionedKeys(ctx: StoryContext, text: string): string[] {
  // A bracketed tag ("Hoffman Rd (Concow)", "(fire now threatening Superior)") is not the area itself.
  const lower = text.replace(/\s*\([^)]*\)/g, "").toLowerCase();
  const out: string[] = [];
  for (const key of ctx.keyZones.keys()) {
    if (key.startsWith("#") || key.length < 4) continue;
    const re = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    for (const m of lower.matchAll(re)) {
      if (!ROAD_SUFFIX.test(lower.slice((m.index ?? 0) + key.length))) {
        out.push(key);
        break;
      }
    }
  }
  return out;
}

/** Road-name spellings matched against labels ("Road" and "Rd" alike). */
function roadKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\broad\b/g, "rd")
    .replace(/\bdrive\b/g, "dr")
    .replace(/\blane\b/g, "ln")
    .replace(/\bavenue\b/g, "ave")
    .replace(/\bboulevard\b/g, "blvd")
    .replace(/\bstreet\b/g, "st")
    .replace(/\bhighway\b/g, "hwy");
}
/** Road abbreviations in labels and the road name they stand for. */
const ROAD_ALIASES: [RegExp, string][] = [[/\bPCH\b/g, "Pacific Coast Highway"]];

let roadNameCache: { model: ReplayModel; byName: Map<string, LngLat[][]> } | null = null;

/** Lines of the named roads a label mentions (two or more words, e.g. "Clark Rd"). */
function namedRoadLines(ctx: StoryContext, text: string, within: AreaGeometry[]): LngLat[][] {
  if (roadNameCache?.model !== ctx.model) {
    const byName = new Map<string, LngLat[][]>();
    for (const r of ctx.model.roads?.items ?? []) {
      if (!r.name || r.coords.length === 0) continue;
      const key = roadKey(r.name);
      if (key.split(" ").length < 2 || key.length < 7) continue;
      const list = byName.get(key) ?? [];
      list.push(r.coords);
      byName.set(key, list);
    }
    roadNameCache = { model: ctx.model, byName };
  }
  let label = text;
  for (const [re, to] of ROAD_ALIASES) label = label.replace(re, to);
  const lower = ` ${roadKey(label).replace(/[^a-z0-9 ]/g, " ")} `;
  // Every match with its span; a name inside a longer matched name ("canyon rd" in
  // "liberty canyon rd") is part of that road, not a road of its own.
  const hits: { name: string; from: number; to: number }[] = [];
  for (const name of roadNameCache.byName.keys()) {
    for (let at = lower.indexOf(` ${name} `); at >= 0; at = lower.indexOf(` ${name} `, at + 1)) {
      hits.push({ name, from: at + 1, to: at + 1 + name.length });
    }
  }
  const kept = new Set(
    hits
      .filter((h) => !hits.some((o) => o !== h && o.to - o.from > h.to - h.from && o.from <= h.from && o.to >= h.to))
      .map((h) => h.name),
  );
  const out: LngLat[][] = [];
  for (const name of kept) out.push(...(roadNameCache.byName.get(name) ?? []));
  const inside = within.length > 0 ? out.filter((l) => within.some((a) => inArea(a, l[Math.floor(l.length / 2)]))) : [];
  return (inside.length > 0 ? inside : out).slice(0, MAX_FOCUS_EDGES);
}

/** A named road longer than this (bounding-box diagonal) is drawn only near its named cross streets. */
const LONG_ROAD_M = 3000;
/** Road ends this close count as one junction. */
const JUNCTION_M = 25;
/** Segments this close to a junction of two named roads are drawn. */
const CROSS_RADIUS_M = 800;
/** Leading words that do not identify a road ("North 68th Street" is known by "68th"). */
const ROAD_PREFIX = /^(?:n|s|e|w|north|south|east|west|old|new|the|upper|lower)$/;

let roadIndexCache: { model: ReplayModel; byName: Map<string, LngLat[][]>; byToken: Map<string, string[]> } | null = null;

function midOf(line: LngLat[]): LngLat {
  return line[Math.floor(line.length / 2)];
}

function extentM(lines: LngLat[][]): number {
  const pts = lines.flat();
  if (pts.length === 0) return 0;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return distanceM([Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]);
}

/** Where two roads meet: ends of their segments within JUNCTION_M of each other. */
function junctions(a: LngLat[][], b: LngLat[][]): LngLat[] {
  const ends = (ls: LngLat[][]) => ls.flatMap((l) => (l.length > 0 ? [l[0], l[l.length - 1]] : []));
  const bEnds = ends(b);
  const out: LngLat[] = [];
  for (const p of ends(a)) if (bEnds.some((q) => distanceM(p, q) <= JUNCTION_M)) out.push(p);
  return out;
}

/** Every `step`-th line, so a capped road keeps its whole extent instead of its first segments. */
function sampleLines(lines: LngLat[][], max: number): LngLat[][] {
  if (lines.length <= max) return lines;
  const step = lines.length / max;
  return Array.from({ length: max }, (_, i) => lines[Math.floor(i * step)]);
}

/**
 * Road lines for a record's spotlight, never a whole long road on a name alone. A named road
 * longer than LONG_ROAD_M is drawn only between (or near) its junctions with other roads the
 * record names, by full name or by their distinctive word ("68th and South Boulder Road").
 * Fire and road records draw any road only near such a junction: a road name says where the
 * record is, not where the fire was along it. Lines left out come back as `context`, so the
 * camera can still frame the named roads. The line cap is shared across the roads drawn.
 */
function recordRoadLines(
  ctx: StoryContext,
  text: string,
  within: AreaGeometry[],
  junctionsOnly: boolean,
): { lines: LngLat[][]; context: LngLat[][] } {
  if (roadIndexCache?.model !== ctx.model) {
    const byName = new Map<string, LngLat[][]>();
    const byToken = new Map<string, string[]>();
    for (const r of ctx.model.roads?.items ?? []) {
      if (!r.name || r.coords.length === 0) continue;
      const key = roadKey(r.name);
      const list = byName.get(key) ?? [];
      list.push(r.coords);
      byName.set(key, list);
      const token = key.split(" ").find((w) => !ROAD_PREFIX.test(w));
      if (token && (token.length >= 4 || /\d/.test(token)) && list.length === 1) {
        byToken.set(token, [...(byToken.get(token) ?? []), key]);
      }
    }
    roadIndexCache = { model: ctx.model, byName, byToken };
  }
  const { byName, byToken } = roadIndexCache;
  let label = text;
  for (const [re, to] of ROAD_ALIASES) label = label.replace(re, to);
  const lower = ` ${roadKey(label).replace(/[^a-z0-9 ]/g, " ")} `;
  // Full names as namedRoadLines matches them (two or more words), longest match wins.
  const hits: { name: string; from: number; to: number }[] = [];
  for (const name of byName.keys()) {
    if (name.split(" ").length < 2 || name.length < 7) continue;
    for (let at = lower.indexOf(` ${name} `); at >= 0; at = lower.indexOf(` ${name} `, at + 1)) {
      hits.push({ name, from: at + 1, to: at + 1 + name.length });
    }
  }
  const spans = hits.filter(
    (h) => !hits.some((o) => o !== h && o.to - o.from > h.to - h.from && o.from <= h.from && o.to >= h.to),
  );
  const named = [...new Set(spans.map((h) => h.name))];
  if (named.length === 0) return { lines: [], context: [] };
  // Cross streets by their distinctive word, outside the full names: capitalised or numbered in the record.
  const words = new Set<string>();
  for (const m of label.matchAll(/\b([A-Z][a-z]{3,}|\d+(?:st|nd|rd|th))\b/g)) {
    const w = roadKey(m[1]);
    // A place the story knows as an area ("in Malibu") is not a cross street.
    if (ctx.keyZones.has(w)) continue;
    const at = lower.indexOf(` ${w} `);
    if (at >= 0 && !spans.some((h) => at + 1 >= h.from && at + 1 < h.to)) words.add(w);
  }
  const tokenRoads = [...words].flatMap((w) => byToken.get(w) ?? []).filter((n) => !named.includes(n));
  const segs = (n: string) => byName.get(n) ?? [];
  const drawn = new Map<string, LngLat[][]>();
  const context: LngLat[][] = [];
  for (const name of named) {
    const own = segs(name);
    const long = extentM(own) > LONG_ROAD_M;
    if (!long && !junctionsOnly) {
      drawn.set(name, own);
      continue;
    }
    const crosses: { road: string; at: LngLat[] }[] = [];
    for (const other of [...named, ...tokenRoads]) {
      if (other === name) continue;
      const at = junctions(own, segs(other));
      if (at.length > 0) crosses.push({ road: other, at });
    }
    if (crosses.length === 0) {
      context.push(...own);
      continue;
    }
    const points = crosses.flatMap((c) => c.at);
    let keep: LngLat[][];
    if (crosses.length >= 2) {
      // Between the named limits: the stretch inside the junctions' bounding box.
      const xs = points.map((p) => p[0]);
      const ys = points.map((p) => p[1]);
      const pad = 0.002;
      keep = own.filter((l) => {
        const [x, y] = midOf(l);
        return x >= Math.min(...xs) - pad && x <= Math.max(...xs) + pad && y >= Math.min(...ys) - pad && y <= Math.max(...ys) + pad;
      });
    } else keep = own.filter((l) => points.some((p) => distanceM(p, midOf(l)) <= CROSS_RADIUS_M));
    drawn.set(name, keep);
    context.push(...own.filter((l) => !keep.includes(l)));
    // A cross street known only by its word is drawn near the junction.
    for (const c of crosses) {
      if (named.includes(c.road)) continue;
      const near = segs(c.road).filter((l) => c.at.some((p) => distanceM(p, midOf(l)) <= CROSS_RADIUS_M));
      drawn.set(c.road, [...(drawn.get(c.road) ?? []), ...near]);
    }
  }
  let lines = [...drawn.values()].filter((l) => l.length > 0);
  if (within.length > 0) {
    const inside = lines.map((ls) => ls.filter((l) => within.some((a) => inArea(a, midOf(l))))).filter((ls) => ls.length > 0);
    if (inside.length > 0) lines = inside;
  }
  const share = Math.max(1, Math.floor(MAX_FOCUS_EDGES / Math.max(1, lines.length)));
  return { lines: lines.flatMap((ls) => sampleLines(ls, share)), context };
}

/** Earliest records of a family naming each key in [from, to). */
function firstByKey(
  ctx: StoryContext,
  keys: Iterable<string>,
  from: number,
  to: number,
  test: (r: RecordRow) => boolean,
  /** When given, records mapped to other zones only are a different area under the same name. */
  zones: Set<string> | null = null,
  /** The latest such record instead of the earliest. */
  latest = false,
): { key: string; name: AreaName | null; row: RecordRow }[] {
  const out: { key: string; name: AreaName | null; row: RecordRow }[] = [];
  // A numbered zone of a named town ("Paradise 2") is the same zone whatever crosswalk a record has.
  const elsewhere = (r: RecordRow, key: string) => {
    const n = r.names.find((x) => x.key === key);
    if (n?.num && n.prefix) return false;
    return zones !== null && zones.size > 0 && r.zoneIds.length > 0 && !r.zoneIds.some((z) => zones.has(z));
  };
  const pool = latest ? [...ctx.rows].reverse() : ctx.rows;
  for (const key of keys) {
    const row = pool.find(
      (r) => r.e.atMs >= from && r.e.atMs < to && test(r) && r.keys.has(key) && !elsewhere(r, key),
    );
    if (row) out.push({ key, name: row.names.find((n) => n.key === key) ?? null, row });
  }
  return out;
}

/** First fire sightings for these keys in [from, to): named sightings, else labels mentioning the place. */
function sightings(ctx: StoryContext, keys: Iterable<string>, from: number, to: number) {
  const out: { name: string; row: RecordRow; quoted: boolean }[] = [];
  for (const key of keys) {
    const named = ctx.rows.find(
      (r) => r.e.type === "fire_arrival" && r.keys.has(key) && r.e.atMs >= from && r.e.atMs < to,
    );
    if (named) {
      out.push({ name: formatNames(named.names.filter((n) => n.key === key)), row: named, quoted: false });
      continue;
    }
    if (key.startsWith("#") || key.length < 4) continue;
    const quoted = ctx.rows.find(
      (r) =>
        r.e.type === "fire_arrival" &&
        r.names.length === 0 &&
        r.e.atMs >= from &&
        r.e.atMs < to &&
        mentionedKeys(ctx, r.text).includes(key),
    );
    if (quoted) out.push({ name: key, row: quoted, quoted: true });
  }
  return out.sort((a, b) => a.row.e.atMs - b.row.e.atMs);
}

/** Fire seen before (or soon after) the decision at t, told as record lines. */
function fireLinkNotes(
  ctx: StoryContext,
  keys: Set<string>,
  t: number,
  what: string,
): { before: ChapterNote[]; after: ChapterNote[] } {
  const notes: ChapterNote[] = [];
  const before = sightings(ctx, keys, t - LINK_MAX_MS, t - 60_000 + 1);
  const named = before.filter((s) => !s.quoted);
  if (named.length > 0) {
    const items = named.slice(0, 3).map((s) => `${s.name} (${span(s.row.e.atMs, t)} earlier)`);
    if (named.length > 3) items.push(`${named.length - 3} more areas`);
    notes.push({
      text: `Fire had already been seen in ${joinAnd(items)} before this ${what}.`,
      evidence: named[0].row.e.evidenceClass,
    });
  }
  const quoted = before.find((s) => s.quoted);
  if (quoted) {
    notes.push({
      text:
        `${capitalise(span(quoted.row.e.atMs, t))} before this ${what}, at ${clock(ctx, quoted.row.e.atMs, t)}, the record has: ` +
        `${sentence(quoted.row.text)}`,
      evidence: quoted.row.e.evidenceClass,
      refId: quoted.row.e.id,
    });
  }
  const seen = new Set(before.map((s) => s.name));
  const after = sightings(ctx, keys, t + 60_000, t + FOLLOW_MS).filter((s) => !s.quoted && !seen.has(s.name));
  const later: ChapterNote[] = [];
  if (after.length > 0) {
    const items = after.slice(0, 3).map((s) => `${span(t, s.row.e.atMs)} later in ${s.name}`);
    later.push({
      text: `Fire was first seen ${joinAnd(items)}.`,
      evidence: after[0].row.e.evidenceClass,
      refId: after.length === 1 ? after[0].row.e.id : undefined,
    });
  }
  return { before: notes, after: later };
}

/** Zone rows whose modelled fire arrival is credible enough to quote. */
function trustedRows(ctx: StoryContext, rows: ZoneInsight[]): ZoneInsight[] {
  const tie = new Map<number, number>();
  for (const z of ctx.insights.values()) {
    if (z.fireArrivalAtMs === null) continue;
    const minute = Math.floor(z.fireArrivalAtMs / 60_000);
    tie.set(minute, (tie.get(minute) ?? 0) + 1);
  }
  return rows.filter(
    (z) =>
      (z.vehicles ?? 0) > 0 &&
      (z.leadTimeS === null || Math.abs(z.leadTimeS) <= MAX_LEAD_S) &&
      (z.fireArrivalAtMs === null || (tie.get(Math.floor(z.fireArrivalAtMs / 60_000)) ?? 0) < TIE_ZONES),
  );
}

/** The model fire starts in this zone: it arrives within a minute of the modelled ignition. */
function startsThere(ctx: StoryContext, z: ZoneInsight): boolean {
  return ctx.ignitionMs !== null && z.fireArrivalAtMs !== null && z.fireArrivalAtMs - ctx.ignitionMs <= 60_000;
}

/** Longest plausible fire for its burned area: an ellipse this many times longer than wide. */
const MAX_FIRE_LENGTH_TO_BREADTH = 8;
/** A recorded fire size is compared with a model arrival up to this long before it. */
const SIZE_CHECK_MS = 2 * 3_600_000;
/** The record first reporting fire in a place this long after the model is a disagreement. */
const LATE_REPORT_MS = 60 * 60_000;
const COUNT_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** "a five-acre fire", "two 30-acre fire spots", "8,000 acres": the phrase and its total acres. */
function recordAcres(text: string): { phrase: string; acres: number } | null {
  const m = text.match(/\b(?:(a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten)[- ]acres?\b(?:\s+(?:fire|spot fire)(?:\s+spots?)?)?\+?/i);
  if (!m) return null;
  const n = (w: string) => COUNT_WORDS[w.toLowerCase()] ?? Number(w.replace(/,/g, ""));
  const acres = n(m[2]) * (m[1] ? n(m[1]) : 1);
  return Number.isFinite(acres) && acres > 0 ? { phrase: m[0].trim(), acres } : null;
}

/**
 * Whether the record contradicts the model fire's arrival in a zone: the record still has a fire
 * far too small to reach the zone from the start (by its stated size), or first reports fire in
 * the zone's named place more than LATE_REPORT_MS later. Returns a sentence saying so, or null.
 */
function earlyFireCaveat(ctx: StoryContext, zones: ZoneInsight[], t: number): string | null {
  const ig = ctx.model.fireSimulated?.ignition;
  if (!ig) return null;
  for (const z of [...zones].sort((a, b) => (a.fireArrivalAtMs ?? 0) - (b.fireArrivalAtMs ?? 0))) {
    const at = z.fireArrivalAtMs;
    const zone = ctx.model.zones?.items.find((x) => x.id === z.zoneId);
    if (at === null || !zone || startsThere(ctx, z) || inArea(zone.geometry, ig.coord)) continue;
    const keys = [...ctx.keyZones.entries()].filter(([, ids]) => ids.has(z.zoneId)).map(([k]) => k);
    const named = ctx.rows.flatMap((r) => r.names).find((n) => keys.includes(n.key));
    const name = zoneName(ctx, z.zoneId) ?? (named ? formatNames([named]) : "this area");
    const d = Math.min(...ringCoords(zone.geometry).map((c) => distanceM(ig.coord, c)));
    const sized = ctx.rows.find((r) => r.e.atMs >= at && r.e.atMs - at <= SIZE_CHECK_MS && recordAcres(r.text) !== null);
    const size = sized ? recordAcres(sized.text) : null;
    if (sized && size) {
      const lengthM = Math.sqrt((size.acres * 4046.86 * 4 * MAX_FIRE_LENGTH_TO_BREADTH) / Math.PI);
      // Twice the generous length bound, so only a clear mismatch is flagged.
      if (d > 2 * lengthM) {
        return (
          `But at ${clock(ctx, sized.e.atMs, t)} the record still has "${size.phrase}", far too small to reach ${name} ` +
          `${(d / 1000).toFixed(1)} km from the start, while the model fire is already there; treat the model's timing for this area as rough.`
        );
      }
    }
    const reported = ctx.rows.find(
      (r) =>
        r.family === "fire" &&
        !/\bthreaten/i.test(r.text) &&
        [...r.keys, ...mentionedKeys(ctx, r.text)].some((k) => keys.includes(k)),
    );
    if (reported && reported.e.atMs - at > LATE_REPORT_MS) {
      return (
        `But the record first reports fire in ${name} only at ${clock(ctx, reported.e.atMs, t)}, ` +
        `${duration(reported.e.atMs - at)} after the model fire gets there, so treat the model's timing there as unreliable.`
      );
    }
  }
  return null;
}

/** Model zone name, short ("Oak Park" for "Oak Park - entire community"). */
function zoneName(ctx: StoryContext, id: string): string | null {
  const z = ctx.model.zones?.items.find((x) => x.id === id);
  if (!z || CENSUS_NAME.test(z.name)) return null;
  return areaName(z.name)?.label ?? z.name;
}

/** "Zone 1 and Zone 4", or null when any zone has no usable name or there are too many. */
function zoneNames(ctx: StoryContext, ids: string[], max = 3): string | null {
  if (ids.length === 0 || ids.length > max) return null;
  const names = ids.map((id) => zoneName(ctx, id));
  return names.every((n): n is string => n !== null) ? joinAnd([...new Set(names)]) : null;
}

/**
 * Why the model cannot say whether its fire reached an area at all, or null when it can: the
 * model front stops early (within HORIZON_MS of the order) or is held inside the first satellite
 * outline. A front limited to the final outline covers the whole fire.
 */
function horizonClause(ctx: StoryContext, t: number): string | null {
  const last = ctx.lastFrontMs;
  if (last === null) return null;
  const toFinal = /\bfinal\b[^.]*perimeter/i.test(ctx.model.fireSimulated?.constraintNote ?? "");
  if (toFinal || (!ctx.clippedToFirst && last >= t + HORIZON_MS)) return null;
  return (
    `the model fire ${last > t ? "stops" : "had stopped"} spreading at ${clock(ctx, last, t)}` +
    (ctx.clippedToFirst ? ", held inside the first satellite outline" : "")
  );
}

/**
 * What the model says happened in the zones an order covered: whether the model fire starts
 * there (then it cannot time the warning), how many the fire reached and when, and how many
 * cars got away before it arrived. Only credible fire arrivals are quoted; when the model fire
 * stops early, "never reached" becomes "cannot say". Null when there is nothing to say.
 */
function orderOutcome(
  ctx: StoryContext,
  rows: ZoneInsight[],
  t: number,
  /** Other zones of the order were told just before, so these are "the other" ones. */
  othersTold = false,
): { text: string; unknown: boolean } | null {
  const homes = rows.filter((z) => (z.vehicles ?? 0) > 0);
  if (homes.length === 0) return null;
  const noun = homes.every((z) => z.zoneId.startsWith("bg:")) ? "neighbourhood" : "area";
  const starts = homes.filter((z) => startsThere(ctx, z));
  const rest = homes.filter((z) => !startsThere(ctx, z));
  const out: string[] = [];
  if (starts.length > 0) {
    const named = zoneNames(ctx, starts.map((z) => z.zoneId));
    const where =
      starts.length === homes.length
        ? homes.length === 1 ? `this ${noun}` : `these ${noun}s`
        : (named ?? `${starts.length} of these ${noun}s`);
    out.push(`In the model the fire starts inside ${where}, so the model cannot say how much warning ${starts.length === 1 ? "it" : "they"} had.`);
    const longAfter = ctx.ignitionMs !== null && t - ctx.ignitionMs > HORIZON_MS;
    if (longAfter && ctx.ignitionMs !== null) {
      out.push(
        `The bundle's first order for ${starts.length === 1 ? "it" : "them"} comes ${span(ctx.ignitionMs, t)} after the model fire starts; ` +
          "the order list may be incomplete there.",
      );
    }
  }
  if (rest.length === 0) return out.length > 0 ? { text: out.join(" "), unknown: false } : null;
  const credible = trustedRows(ctx, rest);
  if (credible.length < rest.length) return out.length > 0 ? { text: out.join(" "), unknown: false } : null;
  const n = credible.length;
  const other = starts.length > 0 || othersTold ? " other" : "";
  const reached = credible.filter((z) => z.fireArrivalAtMs !== null);
  const lead = (z: ZoneInsight) => (z.leadTimeS ?? 0) * 1000;
  const first = reached.filter((z) => lead(z) <= -MIN_DELAY_MS);
  const same = reached.filter((z) => Math.abs(lead(z)) < MIN_DELAY_MS);
  const horizon = horizonClause(ctx, t);
  if (reached.length === 0) {
    const what = n === 1 ? `this${other} ${noun}` : `these ${n}${other} ${noun}s`;
    out.push(
      horizon
        ? `${capitalise(horizon)}, so the model gives no fire-arrival time for ${what}.`
        : n === 1
          ? `In the model, the fire never reaches this${other} ${noun}.`
          : `In the model, the fire reaches none of these ${n}${other} ${noun}s.`,
    );
    return { text: out.join(" "), unknown: horizon !== null };
  }
  const veh = reached.reduce((s, z) => s + (z.vehicles ?? 0), 0);
  const away = reached.reduce((s, z) => s + (z.departedByFireVeh ?? 0), 0);
  const caveat = first.length > 0 ? earlyFireCaveat(ctx, first, t) : null;
  if (n > 1 && reached.length === 1) {
    // One of several areas reached: its own timing, and only its own cars.
    const z = reached[0];
    const at = z.fireArrivalAtMs ?? t;
    const when =
      first.length > 0
        ? `${span(at, t)} before the order`
        : same.length > 0
          ? "at about the same time as the order"
          : `${span(t, at)} after the order`;
    out.push(
      sentence(
        `In the model, the fire reaches 1 of the ${n}${other} ${noun}s this order covers, ${when}; ` +
          (away === 0
            ? `none of the ${fmt(veh)} cars in that ${noun} had left by then`
            : `when it arrived, ${fmt(away)} of the ${fmt(veh)} cars in that ${noun} had left`),
      ),
    );
    if (horizon) out.push(`For the rest, ${horizon}, so the model gives no fire-arrival time for them.`);
    if (caveat) out.push(caveat);
    return { text: out.join(" "), unknown: false };
  }
  if (n === 1) {
    const z = reached[0];
    const at = z.fireArrivalAtMs ?? t;
    let text =
      first.length > 0
        ? `In the model, the fire had already reached this${other} ${noun} ${span(at, t)} before the order`
        : same.length > 0
          ? `In the model, the fire reached this${other} ${noun} at about the same time as the order`
          : `In the model, the order came ${span(t, at)} before the fire reached this${other} ${noun}`;
    text +=
      away === 0
        ? `; none of its ${fmt(veh)} cars had left by then`
        : `; when it arrived, ${fmt(away)} of its ${fmt(veh)} cars had left`;
    out.push(sentence(text));
  } else {
    const all = reached.length === n ? (n === 2 ? "both" : `all ${n}`) : `${reached.length} of the ${n}`;
    const timing =
      first.length === reached.length
        ? ", each before the order"
        : first.length > 0
          ? `, ${first.length} of them before the order`
          : same.length === reached.length
            ? ", at about the same time as the order"
            : ", each after the order";
    out.push(
      sentence(
        `In the model, the fire reaches ${all}${other} ${noun}s this order covers${timing}; ` +
          `${away === 0 ? "none" : fmt(away)} of the ${fmt(veh)} cars in ${reached.length < n ? "those" : "them"} had left before it arrived`,
      ),
    );
    if (reached.length < n && horizon) out.push(`For the rest, ${horizon}, so the model gives no fire-arrival time for them.`);
  }
  if (caveat) out.push(caveat);
  return { text: out.join(" "), unknown: false };
}

/** Modelled departures in the hour after an order, from the per-zone departure curves. */
function departuresNote(ctx: StoryContext, zoneIds: string[], t: number): string | null {
  const deps = ctx.model.traffic?.zoneDepartures ?? {};
  let veh = 0;
  let left = 0;
  for (const id of zoneIds) {
    veh += ctx.insights.get(id)?.vehicles ?? 0;
    const d = deps[id];
    if (!d) continue;
    let k = -1;
    for (let i = 0; i < d.atMs.length && d.atMs[i] <= t + 3_600_000; i += 1) k = i;
    if (k >= 0) left += d.cumVeh[k];
  }
  if (veh <= 0) return null;
  return (
    `In the model, ${fmt(left)} of the ${fmt(veh)} cars here set off within an hour of the order. ` +
    "The pace comes from an assumed response delay, not from observed departures."
  );
}

/**
 * Zones of a decision the model had already ordered before it: "this record changes nothing
 * there", naming the earlier record when it names another place. Null when some zone is new.
 */
function alreadyOrderedNote(ctx: StoryContext, beat: Beat, zoneIds: string[]): ChapterNote | null {
  const all = zoneIds.map((id) => ctx.insights.get(id)).filter((z): z is ZoneInsight => !!z);
  if (all.length === 0 || all.some((z) => z.orderAtMs === null || z.orderAtMs >= beat.atMs - DECISION_MERGE_MS)) return null;
  const firstAt = Math.min(...all.map((z) => z.orderAtMs ?? Infinity));
  const keys = new Set(beat.rows.flatMap((r) => [...r.keys]));
  const names = beat.rows.filter((r) => r.family === "order" || r.family === "warning").flatMap((r) => r.names);
  const earlier = ctx.rows.find(
    (r) => r.family === "order" && Math.abs(r.e.atMs - firstAt) <= DECISION_MERGE_MS && r.zoneIds.some((z) => zoneIds.includes(z)),
  );
  const shared = earlier && earlier.names.length > 0 && ![...earlier.keys].some((k) => keys.has(k));
  const subject = names.length > 0 ? formatNames(names, 3) : "this area";
  const verb = nameCount(names) > 1 ? "are" : "is";
  return {
    text: shared
      ? `In the model ${subject} ${verb} part of the same area as ${formatNames(earlier.names, 2)}, already ordered at ${clock(ctx, firstAt, beat.atMs)}, so this record changes nothing there.`
      : `In the model ${subject} ${verb} already under the order of ${clock(ctx, firstAt, beat.atMs)}, so this record changes nothing there.`,
    evidence: ctx.model.insights?.evidenceClass ?? "simulated",
  };
}

/** The model's note on an order beat: fire outcome, else departures, else why it moves nobody. */
function modelOrderNote(ctx: StoryContext, beat: Beat, zoneIds: string[]): ChapterNote | null {
  if (!ctx.model.traffic) return null;
  const evidence = ctx.model.insights?.evidenceClass ?? "simulated";
  const orders = beat.rows.filter((r) => r.family === "order" && r.e.type !== "evacuation_order_downgraded");
  if (orders.length === 0) return null;
  const statement = orders.every((r) => STATEMENT_OF_NEED.test(r.text));
  const what = statement ? "statement" : orders.every((r) => r.e.type === "evacuation_requested") ? "request" : "order";
  // Only the zones this beat orders count; areas it only warns are told by the warning note.
  const orderZones = new Set(orders.flatMap((r) => r.zoneIds));
  const ids = zoneIds.filter((id) => orderZones.has(id));
  if (ids.length === 0) {
    const eased = beat.rows.some((r) => r.e.type === "evacuation_order_downgraded");
    return {
      text: statement
        ? "The record says evacuations are needed here rather than that an order was issued; the bundle maps no area to it, so the model sends nobody for it."
        : `The bundle has no mapped area for ${eased ? "the new order" : `this ${what}`}, so the model sends nobody for it.`,
      evidence: "simulated",
    };
  }
  const all = ids.map((id) => ctx.insights.get(id)).filter((z): z is ZoneInsight => !!z);
  const rows = all.filter((z) => z.orderAtMs !== null && Math.abs(z.orderAtMs - beat.atMs) <= DECISION_MERGE_MS);
  if (rows.length === 0) return alreadyOrderedNote(ctx, beat, ids);
  const parts: string[] = [];
  const noun = all.every((z) => z.zoneId.startsWith("bg:")) ? "neighbourhood" : "area";
  const older = all.filter((z) => z.orderAtMs !== null && z.orderAtMs < beat.atMs - DECISION_MERGE_MS);
  if (older.length > 0) {
    parts.push(
      `In the model this order newly applies to ${rows.length} of the ${all.length} ${noun}s it orders; ` +
        `${older.length === 1 ? "1 was" : `${older.length} were`} already ordered.`,
    );
  }
  if (rows.every((z) => (z.vehicles ?? 0) === 0)) {
    const named = zoneNames(ctx, rows.map((z) => z.zoneId), 1);
    const households = zonesOfIds(ctx, rows.map((z) => z.zoneId)).reduce((s, z) => s + (z.households ?? 0), 0);
    parts.push(
      `In the model the area this order is mapped to${named ? ` (${named})` : ""} has ` +
        (households > 0 ? `${fmt(households)} households but no modelled cars that can leave` : "no cars") +
        ", so it sets nobody moving.",
    );
    return { text: parts.join(" "), evidence };
  }
  // Map snapshots: the model orders these areas at the snapshot time, which may be late.
  if (orders.every((r) => r.e.timePrecision === "approximate")) {
    parts.push(
      `In the model ${rows.length === 1 ? "this area is" : "these areas are"} ordered only at ${clock(ctx, beat.atMs, beat.atMs)}, ` +
        `the time of the map snapshot; the real ${orders.length === 1 && rows.length === 1 ? "order" : "orders"} may have come earlier.`,
    );
  }
  // Zones the model fire reached long before the order (beyond the lead times orderOutcome quotes).
  const long = rows.filter(
    (z) => !startsThere(ctx, z) && z.leadTimeS !== null && z.leadTimeS < -MAX_LEAD_S && (z.vehicles ?? 0) > 0,
  );
  if (long.length > 0) {
    const named = zoneNames(ctx, long.map((z) => z.zoneId));
    const at = Math.min(...long.map((z) => z.fireArrivalAtMs ?? Infinity));
    const veh = long.reduce((s, z) => s + (z.vehicles ?? 0), 0);
    const away = long.reduce((s, z) => s + (z.departedByFireVeh ?? 0), 0);
    parts.push(
      `The model fire had already reached ${named ?? `${long.length} of these areas`} from ${clock(ctx, at, beat.atMs)}; ` +
        `${away === 0 ? "none" : fmt(away)} of ${long.length === 1 ? "its" : "their"} ${fmt(veh)} cars had left by then.`,
    );
    const caveat = earlyFireCaveat(ctx, long, beat.atMs);
    if (caveat) parts.push(caveat);
  }
  const outcome = orderOutcome(ctx, rows.filter((z) => !long.includes(z)), beat.atMs, long.length > 0);
  const dep = departuresNote(ctx, rows.map((z) => z.zoneId), beat.atMs);
  if (outcome) {
    // Model and record disagree when the model fire is first but the record sees fire later.
    const keys = new Set(orders.flatMap((r) => [...r.keys]));
    const later = keys.size === 1 ? sightings(ctx, keys, beat.atMs, beat.atMs + FOLLOW_MS)[0] : undefined;
    const fireFirst = trustedRows(ctx, rows).some(
      (z) => !startsThere(ctx, z) && z.leadTimeS !== null && z.leadTimeS * 1000 <= -MIN_DELAY_MS,
    );
    parts.push(outcome.text);
    if (fireFirst && later && !later.quoted) {
      parts.push(`The record first sees fire there ${span(beat.atMs, later.row.e.atMs)} after the order, so treat the model's timing as rough.`);
    }
    if (!/cars had left|cars here set off/.test(parts.join(" ")) && dep) parts.push(dep);
  } else if (dep) parts.push(dep);
  return parts.length > 0 ? { text: parts.join(" "), evidence } : null;
}

/** Phrase for cars on roads the model fire has reached; held fronts are an area, not a fire. */
function exposedPhrase(ctx: StoryContext, t: number): string {
  return ctx.lastFrontMs !== null && t > ctx.lastFrontMs + 30 * 60_000
    ? "on roads inside the area the model counts as burned"
    : "on roads the fire has reached";
}

function metricsAt(model: ReplayModel, t: number): TrafficMetrics | null {
  const k = model.traffic ? frameIndexAt(model, t) : -1;
  return k >= 0 ? (model.traffic?.metrics[k] ?? null) : null;
}

/** Where the model stands at t: still at home, on the road, stuck, on burning roads. */
function metricsNote(ctx: StoryContext, t: number): ChapterNote | null {
  const m = metricsAt(ctx.model, t);
  if (!m || (m.enRouteVeh < MIN_HEADLINE_VEH && m.exposedVeh === 0 && m.blockedVeh === 0)) return null;
  const parts = [`${fmt(m.notDepartedVeh)} cars are still at home`, roadParts(ctx, m)];
  if (m.exposedVeh > 0) parts.push(`${fmt(m.exposedVeh)} are ${exposedPhrase(ctx, t)}`);
  // Told at the chapter's minute; the frame is the one in effect then.
  return {
    text: `In the model at ${clock(ctx, t, t)}, ${parts.join("; ")}.`,
    evidence: ctx.model.traffic?.evidenceClass ?? "simulated",
  };
}

/** A log fragment without a verb ("Mandatory evacuation orders south of US-101 …") as a sentence. */
function asSentence(text: string): string {
  return text.replace(
    /^(Mandatory evacuation orders?|Mandatory evacuations?)\s+(?!(?:for|went|are|is|were|was|ordered|issued|in)\b)/i,
    "$1 went out for ",
  );
}

/** Body sentences for a beat's records: request waves, alerts and order lists merged by rule. */
function beatSentences(ctx: StoryContext, beat: Beat): string[] {
  const out: string[] = [];
  const ic = { order: [] as AreaName[], warning: [] as AreaName[] };
  const coded = { order: [] as AreaName[], warning: [] as AreaName[] };
  const named = { order: [] as RecordRow[], warning: [] as RecordRow[] };
  const seen: AreaName[] = [];
  const overrun: string[] = [];
  const rest: string[] = [];
  let phoneSame = false;
  const top = topRow(beat);
  let lead: string | null = null;
  const hasDecision = beat.rows.some((r) => r.family === "order" || r.family === "warning");
  const veh = (r: RecordRow) => r.zoneIds.reduce((s, id) => s + (ctx.insights.get(id)?.vehicles ?? 0), 0);
  // Records logged at a later minute than the beat say when ("At 12:03, fire reported …").
  const when = (r: RecordRow, text: string) =>
    Math.floor(r.e.atMs / 60_000) > Math.floor(beat.atMs / 60_000)
      ? `At ${clock(ctx, r.e.atMs, beat.atMs)}, ${lowerFirst(text)}`
      : text;
  // "… for the listed zones" names them.
  const listed = (r: RecordRow, text: string) =>
    r.names.length > 0 ? text.replace(/\bfor the listed zones\b/i, `for ${formatNames(r.names, 6)}`) : text;
  for (const r of beat.rows) {
    const kind = r.family === "warning" || r.alertKind === "warning" ? "warning" : "order";
    if (/asked for an evacuation (?:order|warning) for/i.test(r.text) && r.names.length > 0) ic[kind].push(...r.names);
    else if (r.family === "alert" && /CodeRED/.test(r.text) && r.names.length > 0) coded[kind].push(...r.names);
    else if (r.family === "alert" && /^Phone alert:/i.test(r.text)) {
      if (hasDecision) phoneSame = true;
      else rest.push(`A phone alert went to ${r.names.length > 0 ? formatNames(r.names, 5, true) : stripTag(r.text)}.`);
    } else if (
      (r.family === "order" || r.family === "warning") &&
      r.names.length > 0 &&
      /^Evacuation (?:order|warning)\b/i.test(r.text) &&
      !/^Evacuation (?:order|warning):\s*\S+(?: \S+)? (?:states|issues|announces|asks)\b/i.test(r.text)
    )
      named[kind].push(r);
    else if (r.e.type === "burnover") overrun.push(...burnoverPlaces([r], true));
    else if (r.e.type === "fire_arrival" && r.names.length > 0) seen.push(...r.names);
    else if (r === top) lead = when(r, sentence(asSentence(listed(r, stripTag(r.text)))));
    else rest.push(when(r, sentence(asSentence(listed(r, stripTag(r.text))))));
  }
  if (lead) out.push(lead);
  if (seen.length > 0) out.push(`Fire was first seen in ${formatNames(seen)}.`);
  // The record's burnovers count people overrun by fire anywhere: on the road, on foot or at a refuge.
  if (overrun.length > 0) {
    out.push(`${overrun.length === 1 ? "A recorded burnover" : "Recorded burnovers"}: fire overran people at ${joinAnd(overrun)}.`);
  }
  const icOrder = ic.order.length > 0
    ? `${nameCount(ic.order) > 1 ? "evacuation orders" : "an evacuation order"} for ${formatNames(ic.order)}`
    : "";
  const icWarn = ic.warning.length > 0
    ? `${nameCount(ic.warning) > 1 ? "warnings" : "a warning"} to get ready to leave for ${formatNames(ic.warning)}`
    : "";
  if (icOrder || icWarn) {
    out.push(`The incident commander asked for ${[icOrder, icWarn].filter(Boolean).join(", and ")}.`);
  }
  if (coded.order.length > 0) out.push(`A CodeRED phone alert told ${formatNames(coded.order)} to leave.`);
  if (coded.warning.length > 0) out.push(`A CodeRED phone alert told ${formatNames(coded.warning)} to get ready to leave.`);
  // Map snapshots (approximate times) say what was in place by then, in one sentence.
  const snapshot: string[] = [];
  for (const kind of ["order", "warning"] as const) {
    const rows = named[kind].sort((a, b) => veh(b) - veh(a));
    if (rows.length === 0) continue;
    const list = formatNames(rows.flatMap((r) => r.names), 4, true);
    const paren = rows.length === 1 ? rows[0].text.match(/\(([^)]+)\)\.?$/)?.[1] : undefined;
    const voluntary = rows.every((r) => /\bvoluntary\b/i.test(r.text));
    const again = kind === "order" && rows.every((r) => r.repeat);
    const what =
      kind === "order"
        ? rows.length > 1 ? "evacuation orders" : "an evacuation order"
        : voluntary
          ? rows.length > 1 ? "voluntary evacuations" : "a voluntary evacuation"
          : rows.length > 1 ? "evacuation warnings (get ready to leave)" : "an evacuation warning (get ready to leave)";
    if (rows.every((r) => r.e.timePrecision === "approximate")) {
      snapshot.push(
        snapshot.length === 0
          ? `${what} ${rows.length > 1 ? "were" : "was"} in place for ${list}`
          : `${what} for ${list}`,
      );
    } else if (again) out.push(`The order for ${list}${paren ? ` (${paren})` : ""} went out again.`);
    else out.push(`${capitalise(what)} went out for ${list}${paren ? ` (${paren})` : ""}.`);
  }
  if (snapshot.length > 0) out.push(`By ${clock(ctx, beat.atMs, beat.atMs)}, ${snapshot.join(", and ")}.`);
  if (phoneSame) out.push("A phone alert went out the same minute.");
  // "Emergency operations centre log: …" twice in a row reads as one log entry with two lines.
  const logTag = /^[\w ]+ log:\s*/i;
  const firstTag = [lead, ...rest].find((x) => x && logTag.test(x))?.match(logTag)?.[0];
  out.push(...rest.map((x) => (firstTag && lead?.startsWith(firstTag) && x.startsWith(firstTag) ? capitalise(x.slice(firstTag.length)) : x)));
  const unique = [...new Set(out)];
  return unique.length > 4 ? [...unique.slice(0, 4), `(${unique.length - 4} more records at the same time.)`] : unique;
}

/** Where the record places its burnovers ("Burnover #22 at Neal Rd (Paradise)." is "Neal Rd"). */
function burnoverPlaces(rows: RecordRow[], withTown = false): string[] {
  return rows.map((r) => {
    const at = r.text.replace(/^Burnover #\d+ at\s*/i, "");
    return sentence(withTown ? at : at.replace(/\s*\([^)]*\)\.?$/, ""), false);
  });
}

function shortTitle(text: string): string | null {
  const t = sentence(stripTag(text.replace(/^[\w ]+ log:\s*/i, "").replace(/\s*\([^)]*\)\.?$/, "")), false);
  if (t.length <= 70) return capitalise(t);
  // A long log line keeps its first clause ("Fire at Mohawk and in the Costco parking lot; smoke …").
  const clause = t.split(/;\s+/)[0];
  return clause.length >= 12 && clause.length <= 70 && clause !== t ? capitalise(clause) : null;
}

/** An order record that states a need for evacuations rather than issuing an order. */
const STATEMENT_OF_NEED = /\b(?:states?|says?)\b[^.]*\bneeded\b/i;

/** A name cut short in the record ("South Boulder North and East of"): not usable as a title. */
const DANGLING_NAME = /\b(?:of|and|to|from|between)$/i;

function beatTitle(ctx: StoryContext, beat: Beat): string {
  const top = topRow(beat);
  const veh = (r: RecordRow) => r.zoneIds.reduce((s, id) => s + (ctx.insights.get(id)?.vehicles ?? 0), 0);
  // Names in the order the body lists them (orders by modelled cars, most first).
  const sameFamily = beat.rows.filter((r) => r.family === top.family);
  const sorted = top.family === "order" && !sameFamily.some((r) => /asked for an evacuation/i.test(r.text));
  const names = (sorted ? [...sameFamily].sort((a, b) => veh(b) - veh(a)) : sameFamily).flatMap((r) => r.names);
  let list = names.length > 0 ? formatNames(names, 3) : "";
  // A name the record cuts short is titled by its first part ("Cherryvale and more").
  if (DANGLING_NAME.test(list) && names.length > 0) {
    const first = names[0].label.split(/ and /)[0];
    list = first && !DANGLING_NAME.test(first) ? `${first} and more` : "";
  }
  const fits = list.length > 0 && list.length <= 48;
  switch (top.family) {
    case "order": {
      if (top.e.type === "evacuation_order_downgraded") {
        const eased = shortTitle(top.text);
        const fresh = beat.rows.some((r) => r.family === "order" && r.e.type !== "evacuation_order_downgraded");
        if (!fresh) return eased ?? "An order is eased";
        const key = mentionedKeys(ctx, top.text)[0];
        const where = key ? ctx.rows.flatMap((r) => r.names).find((n) => n.key === key)?.label : undefined;
        return where ? `${capitalise(where.replace(/^(?:the )?(?:city|town|community|village) of /i, ""))} order eased; a new order goes out` : "An order is eased and a new one goes out";
      }
      // "… states evacuations are needed from …" is told as a statement, not as an issued order.
      if (beat.rows.every((r) => r.family !== "order" || STATEMENT_OF_NEED.test(r.text))) {
        const said = stripTag(top.text).match(/^(.+?)\s+states?\s+(evacuations? (?:are|is) needed\b.*)$/i);
        if (said) {
          const head = `${said[1]} says ${said[2]}`;
          const cut = head.match(/^(.{12,80}?)(?=,|;| and from\b| and north\b| and south\b|\.|$)/);
          return capitalise(sentence(cut ? cut[1] : head, false));
        }
      }
      // "All of X" leads only when that order covers most of the beat's mapped zones.
      const zones = new Set(beat.rows.flatMap((r) => r.zoneIds));
      const all = beat.rows.find(
        (r) =>
          r.family === "order" &&
          r.names.length > 0 &&
          /\b(?:all of|entire|town-wide|citywide)\b/i.test(r.text) &&
          r.zoneIds.length * 2 >= zones.size,
      );
      const orderRows = beat.rows.filter((r) => r.family === "order");
      // Re-sent: every name was ordered before (by name, not just by zone: "Concow" inside Pulga's zone is new).
      const namedBefore = (r: RecordRow) =>
        r.keys.size > 0 &&
        [...r.keys].every((k) => ctx.rows.some((o) => o.family === "order" && o.e.atMs < r.e.atMs - 60_000 && o.keys.has(k)));
      if (fits && orderRows.length > 0 && orderRows.every((r) => r.repeat && namedBefore(r))) return `The order for ${list} goes out again`;
      if (all) return `All of ${all.names[0].label.replace(/^(?:all of )?(?:the )?(?:(?:city|town|community|village) of )?/i, "")} is ordered to leave`;
      if (fits && top.sameName) return `More of ${list} is ordered to leave`;
      if (fits) return capitalise(`${list} ${nameCount(names) > 1 ? "are" : "is"} ordered to leave`);
      const two = formatNames(names, 2);
      if (two && two.length <= 64) return capitalise(`${nameCount(names) > 1 ? "Orders" : "Order"} for ${two}`);
      if (names.length > 1 && names[0].label.length <= 56) return capitalise(`Orders for ${names[0].label} and more`);
      const short = shortTitle(top.text);
      if (short) return /^from\b/i.test(short) ? `Order for the area ${lowerFirst(short)}` : short;
      // "… evacuations are needed from Kanan Rd to Westlake Blvd and from …": the first stretch.
      const stretch = stripTag(top.text).match(/\b((?:from|between) .{6,48}?)(?=,|;| and from\b| and north\b| and south\b|\.|$)/i);
      if (stretch) return `Order for the area ${stretch[1]}`;
      return ctx.rows.some((r) => r.family === "order" && r.e.atMs < top.e.atMs) ? "Another evacuation order" : "A new evacuation order";
    }
    case "warning":
      return list ? capitalise(`${list} told to get ready to leave`) : (shortTitle(top.text) ?? "A warning to get ready");
    case "alert": {
      const whole = names.length > 0 ? formatNames(names, 3, true) : "";
      const shown = whole && whole.length <= 56 ? whole : list;
      return shown
        ? capitalise(`${top.repeat ? "Another phone alert" : "Phone alert"} for ${shown}`)
        : (shortTitle(top.text) ?? "A phone alert goes out");
    }
    case "fire": {
      const seen = beat.rows.filter((r) => r.e.type === "fire_arrival" && r.names.length > 0).flatMap((r) => r.names);
      if (seen.length > 0) return capitalise(`Fire seen in ${formatNames(seen, 3)}`);
      if (beat.rows.every((r) => r.e.type === "burnover")) {
        const at = burnoverPlaces(beat.rows);
        return beat.rows.length === 1 && at[0] && at[0].length <= 48 ? `A recorded burnover at ${at[0]}` : `${beat.rows.length} recorded burnovers`;
      }
      const short = shortTitle(top.text);
      if (short) return short;
      // A long report keeps its opening clause ("Fire jumps US-101 between ...").
      const clause = stripTag(top.text).match(/^(.{12,64}?)(?:,|\s+(?:between|near|along|with)\b)/i);
      if (clause) return capitalise(clause[1]);
      return TYPE_TITLE[top.e.type] ?? "A report from the fire";
    }
    default: {
      if (top.e.type === "contraflow_started") {
        const before = ctx.rows.some((r) => r.e.type === "contraflow_started" && r.e.atMs < top.e.atMs);
        return before ? "More lanes turned outbound" : "Lanes turned outbound";
      }
      // Several closures of one road: "US 101 closed in 4 stretches".
      const closed = beat.rows.filter((r) => r.e.type === "road_closed");
      if (closed.length > 1) {
        const words = closed.map((r) => r.text.split(/\s+/));
        let n = 0;
        while (words.every((w) => w[n] !== undefined && w[n] === words[0][n] && !/^closed$/i.test(w[n]))) n += 1;
        if (n > 0) return `${words[0].slice(0, n).join(" ")} closed in ${closed.length} stretches`;
      }
      if (top.e.type === "civilian_fatality" && /\b(?:two|three|\d+) civilian fatalities\b/i.test(top.text)) {
        return "Civilian deaths are recorded";
      }
      return shortTitle(top.text) ?? TYPE_TITLE[top.e.type] ?? "From the record";
    }
  }
}

/** The record whose zones the beat outlines: an order before a warning before an alert. */
function zoneOwner(beat: Beat): RecordRow | undefined {
  const rank: Family[] = ["order", "warning", "alert", "road", "fire", "other"];
  return beat.rows
    .filter((r) => r.zoneIds.length > 0)
    .sort((a, b) => rank.indexOf(a.family) - rank.indexOf(b.family))[0];
}

const SPOT_LABEL: Record<Family, string> = {
  order: "ORDERED OUT",
  warning: "TOLD TO GET READY",
  alert: "PHONE ALERT",
  road: "ROAD ACTION",
  fire: "FIRE SEEN",
  other: "",
};

/** Destinations (shelters, refuges) a label names, as map points. */
function namedPlaces(ctx: StoryContext, text: string): LngLat[] {
  const lower = text.toLowerCase();
  return (ctx.model.destinations?.items ?? [])
    .filter((d) => {
      if (d.kind === "exit") return false;
      // "TRA-A: Camelot Meadow …" is named in labels by either part.
      return [d.name, ...d.name.split(/:\s*/).slice(1)].some((n) => n.length >= 8 && lower.includes(n.toLowerCase()));
    })
    .map((d) => d.coord);
}

/**
 * Map highlight for a beat. Outlines come only from the beat's own zones, or (labelled as named,
 * not mapped) from zones borrowed by exact area name; fire and road records never outline a whole
 * zone they merely mention. Roads named in an order's text are its boundaries, labelled so.
 */
function beatSpot(
  ctx: StoryContext,
  beat: Beat,
  zoneIds: string[],
  borrowed = false,
): { spot: Spotlight; focus: LngLat[] } {
  const top = topRow(beat);
  let areas = zonesOf(ctx, zoneIds);
  const fireRun = beat.rows.some((r) => r.family === "fire");
  const decision = top.family === "order" || top.family === "warning" || top.family === "alert";
  const lines = beat.rows.flatMap((r) => eventLines(r.e, ctx.roads)).slice(0, MAX_FOCUS_EDGES);
  let text = beat.rows.map((r) => r.text).join(" ");
  if (areas.length === 0 && lines.length === 0 && top.family === "other") {
    areas = zonesOf(ctx, mentionedKeys(ctx, text).flatMap((k) => [...(ctx.keyZones.get(k) ?? [])]));
  }
  // An eased order outlines the area it eases; the new order's boundary roads are not that area.
  const eased = top.e.type === "evacuation_order_downgraded";
  if (eased && lines.length === 0) {
    text = top.text;
    if (areas.length === 0) areas = zonesOf(ctx, mentionedKeys(ctx, top.text).flatMap((k) => [...(ctx.keyZones.get(k) ?? [])]));
  }
  // Fire and road records light a road only near a junction the record names.
  const junctionsOnly = fireRun || top.family === "road";
  const roadText = recordRoadLines(ctx, text, areas, junctionsOnly);
  const named = lines.length === 0 ? roadText.lines : [];
  const places = namedPlaces(ctx, text);
  // A burnover's place is its road, not the fire observations of the moment.
  const burnover = beat.rows.every((r) => r.e.type === "burnover");
  const points = [
    ...places,
    ...(fireRun && !burnover ? observationCoords(ctx.model, beat.atMs, 10 * 60_000, 2 * 60_000).slice(0, 40) : []),
  ];
  const ordered = new Set(beat.rows.filter((r) => r.family === "order").flatMap((r) => r.zoneIds));
  const warned = beat.rows.filter((r) => r.family === "warning").flatMap((r) => r.zoneIds).filter((z) => !ordered.has(z));
  const roadNamed = lines.length === 0 && named.length > 0;
  const typeLabel =
    top.e.type === "evacuation_order_downgraded"
      ? "ORDER EASED"
      : top.e.type === "burnover"
        ? "OVERRUN BY FIRE"
        : top.e.type === "contraflow_started"
          ? "CONTRAFLOW"
          : top.e.type === "road_closed"
            ? "ROAD CLOSED"
            : top.e.type === "road_blocked"
              ? "ROAD BLOCKED"
              : null;
  const label = typeLabel
    ? typeLabel
    : areas.length > 0 && borrowed
      ? top.family === "fire" ? "FIRE SEEN (NAMED AREA)" : "NAMED AREA (NOT MAPPED)"
      : areas.length > 0 && ordered.size > 0 && warned.length > 0
        ? beat.rows.filter((r) => r.family === "warning").every((r) => /\bvoluntary\b/i.test(r.text))
          ? "ORDERED OUT · VOLUNTARY EVACUATION"
          : "ORDERED OUT · TOLD TO GET READY"
        : areas.length > 0
          ? SPOT_LABEL[zoneOwner(beat)?.family ?? top.family]
          : roadNamed && decision
            ? "ROADS NAMED IN THE RECORD"
            : places.length > 0 && top.family === "other"
              ? "NAMED PLACE"
              : SPOT_LABEL[top.family];
  const s = spot(label, { points, lines: lines.length > 0 ? lines : named, areas });
  const subject = spotCoords(s);
  // A fire record with no place of its own still frames the fire as it stands; roads the record
  // names but the spotlight leaves out still steer the camera when nothing else is lit.
  const fire = fireRun ? fireCoords(ctx.model, beat.atMs) : [];
  const unlit = subject.length > 0 || lines.length > 0 ? [] : roadText.context.flat();
  const focus = subject.length > 0 ? [...subject, ...fire] : [...unlit, ...fire];
  return { spot: subject.length > 0 ? s : spot("", {}), focus };
}

/** Event ids each chapter tells, so a forward link to a record another chapter tells can be dropped. */
const TOLD = new WeakMap<Chapter, Set<string>>();
/** Titles to try, in order, for a chapter whose title repeats an earlier one; all from its records. */
const ALT_TITLE = new WeakMap<Chapter, string[]>();

/** "12 minutes earlier, at 12:49, the record has: …" for a record before t. */
function recordQuote(ctx: StoryContext, r: RecordRow, t: number): ChapterNote {
  return {
    text: `${capitalise(span(r.e.atMs, t))} earlier, at ${clock(ctx, r.e.atMs, t)}, the record has: ${sentence(stripTag(r.text))}`,
    evidence: r.e.evidenceClass,
    refId: r.e.id,
  };
}

/** Whether a record names a place of the beat: a shared area key, or a named road inside its zones. */
function sharesPlace(ctx: StoryContext, r: RecordRow, keys: Set<string>, areas: AreaGeometry[]): boolean {
  if ([...r.keys, ...mentionedKeys(ctx, r.text)].some((k) => keys.has(k))) return true;
  if (areas.length === 0) return false;
  const lines = r.e.edgeIds.length > 0 ? eventLines(r.e, ctx.roads) : namedRoadLines(ctx, r.text, []);
  return lines.some((l) => areas.some((a) => inArea(a, l[Math.floor(l.length / 2)])));
}

/** In the model, the edges of a road record were already closed before t (by its fire or an earlier record). */
function closedBeforeNote(ctx: StoryContext, e: ReplayEvent, t: number): ChapterNote | null {
  const traffic = ctx.model.traffic;
  if (!traffic || e.edgeIds.length === 0 || !/^road_(?:closed|blocked)$/.test(e.type)) return null;
  const index = new Map(traffic.edgeIds.map((id, i) => [id, i]));
  const wanted = new Set(e.edgeIds.map((id) => index.get(id)).filter((i): i is number => i !== undefined));
  // Every edge of the record closed, each from its first closure; the stretch is closed from the last of them.
  const firstBy = new Map<number, number>();
  for (const [i, from] of traffic.closures) if (wanted.has(i)) firstBy.set(i, Math.min(firstBy.get(i) ?? Infinity, from));
  if (wanted.size === 0 || firstBy.size < wanted.size) return null;
  const at = traffic.frames[Math.max(...firstBy.values())]?.atMs;
  if (at === undefined || at > t - MIN_DELAY_MS) return null;
  return {
    text: `In the model this stretch had already been closed since ${clock(ctx, at, t)}, so this record changes nothing there.`,
    evidence: traffic.evidenceClass,
  };
}

/** Decision-to-consequence notes for a beat, record lines first, at most two model lines. */
function beatNotes(ctx: StoryContext, beat: Beat, zoneIds: string[]): ChapterNote[] {
  const t = beat.atMs;
  const record: ChapterNote[] = [];
  let model: ChapterNote | null = null;
  let modelExtra: ChapterNote | null = null;
  const top = topRow(beat);
  const keysOf = (f: (r: RecordRow) => boolean) => new Set(beat.rows.filter(f).flatMap((r) => [...r.keys]));
  const isOrderRow = (r: RecordRow) => r.family === "order" && r.e.type !== "evacuation_order_downgraded";
  const orderKeys = keysOf(isOrderRow);
  const area = new Set(beat.rows.flatMap((r) => r.zoneIds));
  const warnKeys = keysOf((r) => r.family === "warning");
  const alertKeys = keysOf((r) => r.family === "alert");
  // Hits grouped by minute (a request wave is many records), earliest first.
  const groupBy = (hits: { key: string; name: AreaName | null; row: RecordRow }[]) => {
    const by = new Map<number, [RecordRow, AreaName[]]>();
    for (const h of hits) {
      const minute = Math.floor(h.row.e.atMs / 60_000);
      const entry = by.get(minute) ?? [h.row, []];
      if (h.name) entry[1].push(h.name);
      by.set(minute, entry);
    }
    return [...by.values()].sort((a, b) => a[0].e.atMs - b[0].e.atMs);
  };
  // Hits are named as the beat names them ("Paradise zone 2", not the alert's "zone 2").
  const own = beat.rows.flatMap((r) => r.names);
  const label = (names: AreaName[], fallback: string) => {
    const keys = new Set(names.map((n) => n.key));
    const mine = own.filter((n) => keys.has(n.key));
    const shown = nameCount(mine) === keys.size ? mine : names;
    return shown.length > 0 ? formatNames(shown, 4) : fallback;
  };
  const cited = new Set<RecordRow>();

  if (top.family === "order" || top.family === "warning") {
    const keys = new Set([...orderKeys, ...warnKeys]);
    const what =
      orderKeys.size > 0 && warnKeys.size > 0 ? "decision" : top.family === "order" ? "order" : "warning";
    const fire = fireLinkNotes(ctx, keys, t, what);
    record.push(...fire.before);
    // Fire records logged in the same minute as the decision (or a minute or two either side, when
    // they name no area), told beside it only when they name one of its places.
    const areas = zonesOf(ctx, area);
    const placeKeys = new Set([...keys, ...beat.rows.flatMap((r) => mentionedKeys(ctx, r.text))]);
    const alongside = ctx.rows
      .filter(
        (r) =>
          groupOf(r) === "fire" &&
          !beat.rows.includes(r) &&
          isCandidate(r) &&
          (Math.abs(r.e.atMs - t) < 60_000 || (Math.abs(r.e.atMs - t) <= ALONGSIDE_MS && r.names.length === 0)) &&
          sharesPlace(ctx, r, placeKeys, areas),
      )
      .sort((a, b) => Math.abs(a.e.atMs - t) - Math.abs(b.e.atMs - t))[0];
    if (alongside) {
      const d = Math.floor(alongside.e.atMs / 60_000) - Math.floor(t / 60_000);
      const when = d === 0 ? "The same minute" : `${duration(Math.abs(d) * 60_000)} ${d < 0 ? "earlier" : "later"}`;
      record.push({
        text: `${capitalise(when)}, the record has: ${sentence(stripTag(alongside.text))}`,
        evidence: alongside.e.evidenceClass,
        refId: alongside.e.id,
      });
    }
    const afterwards: ChapterNote[] = [];
    if (orderKeys.size > 0) {
      const warned = groupBy(firstByKey(ctx, orderKeys, t - WARNING_LINK_MS, t - 60_000 + 1, (r) => r.family === "warning"));
      for (const [row, names] of warned.slice(0, 1)) {
        if (t - row.e.atMs < MIN_DELAY_MS) continue;
        cited.add(row);
        afterwards.push({
          text: capitalise(`${label(names, "these areas")} had been told to get ready ${span(row.e.atMs, t)} earlier.`),
          evidence: row.e.evidenceClass,
        });
      }
      const before = new Set(
        firstByKey(ctx, orderKeys, t - LINK_MAX_MS, t, (r) => r.family === "alert" && r.alertKind !== "warning", area).map(
          (h) => h.key,
        ),
      );
      // An alert belongs to the order whose names it repeats: one that a later order also names is that order's.
      const laterOrder = (a: RecordRow) =>
        ctx.rows.some(
          (o) => isOrderRow(o) && !beat.rows.includes(o) && o.e.atMs > t + DECISION_MERGE_MS && o.e.atMs <= a.e.atMs && [...o.keys].some((k) => a.keys.has(k)),
        );
      const alerts = groupBy(
        firstByKey(
          ctx,
          [...orderKeys].filter((k) => !before.has(k)),
          t + 60_000,
          t + LINK_MAX_MS,
          (r) => r.family === "alert" && r.alertKind !== "warning" && !/recall attempt/i.test(r.e.label) && !laterOrder(r),
          area,
        ),
      );
      for (const [row, names] of alerts.slice(0, 2)) {
        if (row.e.atMs - t < MIN_DELAY_MS) continue;
        // The alert's own list, not just the areas it shares with this order.
        const whole = row.names.length > names.length ? formatNames(row.names, 5) : label(names, "these areas");
        record.push({
          text: `A phone alert telling ${whole} to leave followed ${span(t, row.e.atMs)} later, at ${clock(ctx, row.e.atMs, t)}.`,
          evidence: row.e.evidenceClass,
          refId: row.e.id,
        });
      }
      const earlier = groupBy(firstByKey(ctx, orderKeys, t - LINK_MAX_MS * 3, t - DECISION_MERGE_MS, isOrderRow, area));
      for (const [row, names] of earlier.slice(0, 1)) {
        cited.add(row);
        // Named in the earlier record's own words ("Malibu", not this order's "all of the City of Malibu").
        afterwards.push({
          text: capitalise(`${names.length > 0 ? formatNames(names, 4) : "these areas"} had already been ordered to leave ${span(row.e.atMs, t)} earlier, at ${clock(ctx, row.e.atMs, t)}.`),
          evidence: row.e.evidenceClass,
        });
      }
      const noCars = zoneIds.length > 0 && zoneIds.every((id) => (ctx.insights.get(id)?.vehicles ?? 0) === 0);
      if (zoneIds.length === 0 || noCars) {
        const later = groupBy(
          firstByKey(ctx, orderKeys, t + DECISION_MERGE_MS, t + 2 * WARNING_LINK_MS, (r) => isOrderRow(r) && r.zoneIds.length > 0 && !r.zoneIds.every((z) => zoneIds.includes(z))),
        );
        for (const [row, names] of later.slice(0, 1)) {
          afterwards.push({
            text: `The next order naming ${label(names, "this area")} is at ${clock(ctx, row.e.atMs, t)}, ${span(t, row.e.atMs)} later.`,
            evidence: row.e.evidenceClass,
            refId: row.e.id,
          });
        }
      }
      // Requests, warnings and field evacuations for the same area or place in the hours before,
      // so an order is not read against a fire report alone.
      const leadUp = ctx.rows
        .filter(
          (r) =>
            !beat.rows.includes(r) &&
            !cited.has(r) &&
            /^(?:evacuation_warning|evacuation_requested|evacuation_started)$/.test(r.e.type) &&
            // Waves of numbered-zone requests are told by the wave notes, not one row at a time.
            !(r.names.length > 0 && r.names.every((n) => n.num !== null)) &&
            ![...r.keys].some((k) => orderKeys.has(k)) &&
            r.e.atMs >= t - LINK_MAX_MS / 4 &&
            r.e.atMs <= t - 60_000 &&
            (r.zoneIds.some((z) => area.has(z)) || mentionedKeys(ctx, r.text).some((k) => orderKeys.has(k)) || [...r.keys].some((k) => orderKeys.has(k))),
        )
        .slice(-2);
      afterwards.unshift(...leadUp.map((r) => recordQuote(ctx, r, t)));
      // One table says all of a town is ordered while another still lists warnings for its zones.
      const whole = beat.rows.find((r) => isOrderRow(r) && /\ball of\b/i.test(r.text) && r.names.length === 1);
      if (whole) {
        const town = whole.names[0].key;
        const other = ctx.rows.filter(
          (r) =>
            (r.family === "warning" || isOrderRow(r)) &&
            tableOf(r.e) !== tableOf(whole.e) &&
            r.e.atMs <= t &&
            t - r.e.atMs <= 2 * DECISION_MERGE_MS &&
            r.names.some((n) => n.prefix?.toLowerCase() === town),
        );
        const warnedOnly = other.filter((r) => r.family === "warning");
        const orderedThere = other.filter((r) => r.family === "order").flatMap((r) => r.names);
        if (warnedOnly.length > 0) {
          for (const r of other) cited.add(r);
          afterwards.unshift({
            text:
              `${capitalise(span(warnedOnly[0].e.atMs, t))} earlier, ` +
              (other.every((r) => /incident commander/i.test(r.text)) ? "the incident commander's requests in another table of the record " : "another table of the record ") +
              (orderedThere.length > 0 ? `have orders for ${formatNames(orderedThere, 6)} but ` : "") +
              `only warnings for ${formatNames(warnedOnly.flatMap((r) => r.names), 9)}; the two records differ.`,
            evidence: warnedOnly[0].e.evidenceClass,
          });
        }
      }
    }
    if (warnKeys.size > 0 && top.family === "warning") {
      const ordered = groupBy(firstByKey(ctx, warnKeys, t + 60_000, t + WARNING_LINK_MS, isOrderRow));
      for (const [row, names] of ordered.slice(0, 1)) {
        record.push({
          text: `The order to leave ${label(names, "these areas")} followed ${span(t, row.e.atMs)} later.`,
          evidence: row.e.evidenceClass,
          refId: row.e.id,
        });
      }
    }
    record.push(...afterwards, ...fire.after);
    if (top.e.type === "evacuation_order_downgraded") {
      // An eased order, set against the order for the same zones it eases.
      const zones = new Set(
        zoneIds.length > 0 ? zoneIds : mentionedKeys(ctx, top.text).flatMap((k) => [...(ctx.keyZones.get(k) ?? [])]),
      );
      const eased = ctx.rows.find((r) => isOrderRow(r) && r.e.atMs < t && r.zoneIds.some((z) => zones.has(z)));
      if (eased) {
        record.unshift({
          text: `The order it eases had come ${span(eased.e.atMs, t)} earlier, at ${clock(ctx, eased.e.atMs, t)}.`,
          evidence: eased.e.evidenceClass,
        });
      }
      if (ctx.model.traffic) {
        modelExtra = { text: "The model has no way to represent an order being eased.", evidence: "simulated" };
      }
    }
    model = modelOrderNote(ctx, beat, zoneIds);
    const hold = warningHoldNote(ctx, beat);
    if (!model) model = hold;
    else modelExtra = modelExtra ?? hold;
  } else if (top.family === "alert") {
    const warns = top.alertKind === "warning";
    // The order (or warning) this alert passes on: the latest before it for the same names.
    const asked = groupBy(
      firstByKey(ctx, alertKeys, t - LINK_MAX_MS, t - 60_000 + 1, warns ? (r) => r.family === "warning" : isOrderRow, area, true),
    );
    for (const [row, names] of asked.slice(0, 1)) {
      // A repeat alert is told against the first alert, not the order.
      if (t - row.e.atMs < MIN_DELAY_MS || top.repeat) continue;
      record.push({
        text: `This alert went out ${span(row.e.atMs, t)} after the ${warns ? "warning" : "order"} for ${label(names, "these areas")} (${clock(ctx, row.e.atMs, t)}).`,
        evidence: row.e.evidenceClass,
      });
    }
    record.push(...fireLinkNotes(ctx, alertKeys, t, "alert").before.filter((n) => n.text.startsWith("Fire had")));
    const earlier = groupBy(firstByKey(ctx, alertKeys, t - LINK_MAX_MS, t - 60_000 + 1, (r) => r.family === "alert", area));
    for (const [row, names] of earlier.slice(0, 1)) {
      record.push({
        text: capitalise(`${label(names, "these areas")} had first been alerted at ${clock(ctx, row.e.atMs, t)}, ${span(row.e.atMs, t)} earlier.`),
        evidence: row.e.evidenceClass,
      });
    }
    const recall = ctx.rows.find(
      (r) => r.e.id !== top.e.id && r.e.atMs > t && r.e.atMs <= t + 30 * 60_000 && r.e.label === top.e.label.replace(/initial attempt/i, "recall attempt"),
    );
    if (recall) {
      record.push({ text: `The message was sent again at ${clock(ctx, recall.e.atMs, t)}.`, evidence: recall.e.evidenceClass });
    }
  } else if (top.family === "fire") {
    const keys = keysOf((r) => r.e.type === "fire_arrival");
    const ordered = groupBy(firstByKey(ctx, keys, t - LINK_MAX_MS, t + 1, isOrderRow));
    const orderedKeys = new Set(ordered.flatMap(([row]) => [...row.keys]));
    for (const [row, names] of ordered.slice(0, 1)) {
      // Measured from the sighting of that area, which may be a minute or two into the beat.
      const sight = beat.rows.find((r) => r.e.type === "fire_arrival" && [...r.keys].some((k) => row.keys.has(k)));
      const seenAt = sight?.e.atMs ?? t;
      if (seenAt - row.e.atMs < 0) continue;
      record.push({
        text: capitalise(`${label(names, "this area")} had been ordered to leave ${span(row.e.atMs, seenAt)} before this sighting.`),
        evidence: row.e.evidenceClass,
      });
    }
    const waiting = [...keys].filter((k) => !orderedKeys.has(k));
    const warnedLater = firstByKey(ctx, waiting, t + 60_000, t + LINK_MAX_MS, (r) => r.family === "warning");
    const orderedLater = firstByKey(ctx, waiting, t + 60_000, t + LINK_MAX_MS, isOrderRow);
    if (orderedLater.length > 0 || warnedLater.length > 0) {
      const o = orderedLater[0];
      const w = warnedLater[0];
      const names = formatNames([...(o?.name ? [o.name] : []), ...(w?.name ? [w.name] : [])], 3) || "this area";
      const parts = [
        ...(w ? [`a warning to get ready ${span(t, w.row.e.atMs)} later`] : []),
        ...(o ? [`an order to leave ${span(t, o.row.e.atMs)} later`] : []),
      ];
      record.push({
        text: `Nobody had been ordered out of ${names} yet: the record has ${joinAnd(parts)}.`,
        evidence: (o ?? w).row.e.evidenceClass,
      });
    }
    const alerted = groupBy(
      firstByKey(ctx, keys, t + 60_000, t + LINK_MAX_MS, (r) => r.family === "alert" && !/recall attempt/i.test(r.e.label)),
    );
    for (const [row, names] of alerted.slice(0, 1)) {
      record.push({
        text: `The first phone alert for ${label(names, "this area")} after this sighting went out ${span(t, row.e.atMs)} later.`,
        evidence: row.e.evidenceClass,
        refId: row.e.id,
      });
    }
    // Field evacuations and facility moves logged during a run of fire reports, told beside it.
    const last = beat.rows[beat.rows.length - 1].e.atMs;
    const during = ctx.rows.filter(
      (r) =>
        /^(?:evacuation_started|facility_evacuated)$/.test(r.e.type) &&
        r.e.atMs >= t - 60_000 &&
        r.e.atMs <= last + 60_000,
    );
    for (const r of during.slice(0, 2)) {
      record.push({
        text: `At ${clock(ctx, r.e.atMs, t)}, the record has: ${sentence(stripTag(r.text))}`,
        evidence: r.e.evidenceClass,
      });
    }
    model = metricsNote(ctx, t);
  } else if (top.family === "road") {
    const roadRow = top;
    if (/\[unresolved/i.test(roadRow.e.label)) {
      record.push({
        text: "The bundle could not place this on its road map, so it is not drawn and the model does not include it.",
        evidence: "derived",
      });
    } else if (roadRow.e.edgeIds.length === 0 && roadRow.e.type !== "road_blocked") {
      record.push({
        text: "The record gives no road segments for this, so the model does not apply it.",
        evidence: "derived",
      });
    }
    // When each closure in the beat ended, grouped by how long it lasted.
    const ends = new Map<string, { n: number; evidence: EvidenceClass }>();
    const closures = beat.rows.filter((r) => r.e.type === "road_closed");
    for (const r of closures) {
      const reopenId = r.e.id.replace(/closure/, "reopen");
      const reopen = reopenId !== r.e.id ? ctx.rows.find((x) => x.e.id === reopenId) : undefined;
      if (!reopen) continue;
      const d = span(r.e.atMs, reopen.e.atMs);
      ends.set(d, { n: (ends.get(d)?.n ?? 0) + 1, evidence: reopen.e.evidenceClass });
    }
    if (ends.size > 0) {
      const groups = [...ends.entries()];
      record.push({
        text:
          closures.length === 1
            ? `It ended ${groups[0][0]} later.`
            : `They reopened after ${joinAnd(groups.map(([d, g]) => (groups.length === 1 ? d : `${d} (${g.n} of them)`)))}.`,
        evidence: groups[0][1].evidence,
      });
    }
    model = closedBeforeNote(ctx, roadRow.e, t) ?? metricsNote(ctx, t);
  } else if (top.e.type === "civilian_fatality" || top.e.type === "entrapment") {
    record.push({
      text: "The model does not simulate deaths or rescues; nothing on the map is tied to this record.",
      evidence: "simulated",
    });
  } else if (/^evacuation_|^facility_/.test(top.e.type)) {
    // A reported evacuation of a named place, set against that place's order.
    for (const key of mentionedKeys(ctx, top.text)) {
      const o = ctx.rows.find((r) => isOrderRow(r) && r.keys.has(key) && r.e.atMs < t);
      if (!o) continue;
      const name = o.names.find((n) => n.key === key);
      record.push({
        text: `The order for ${name ? formatNames([name]) : key} had come ${span(o.e.atMs, t)} earlier, at ${clock(ctx, o.e.atMs, t)}.`,
        evidence: o.e.evidenceClass,
      });
      break;
    }
    model = metricsNote(ctx, t);
  }
  if (top.e.timePrecision === "approximate" && !(top.family === "order" || top.family === "warning")) {
    record.unshift({ text: "The record gives this time as approximate.", evidence: top.e.evidenceClass });
  }
  // Other records of the beat with an approximate time say so too.
  const loose =
    top.e.timePrecision === "approximate"
      ? undefined
      : beat.rows.find((r) => r !== top && r.e.timePrecision === "approximate" && r.family !== "order" && r.family !== "warning");
  if (loose) {
    record.push({
      text: `The record gives the time of ${loose.e.type === "burnover" ? "the burnover" : "that report"} (${clock(ctx, loose.e.atMs, t)}) as approximate.`,
      evidence: loose.e.evidenceClass,
    });
  }
  const models = [model, modelExtra].filter((n): n is ChapterNote => n !== null);
  const out: ChapterNote[] = [...record.slice(0, MAX_NOTES - models.length), ...models];
  return dedupeNotes(out);
}

function dedupeNotes(notes: ChapterNote[]): ChapterNote[] {
  const seen = new Set<string>();
  return notes.filter((n) => !seen.has(n.text) && seen.add(n.text) !== undefined);
}

/**
 * A warning moves nobody in the model: departures from its zones start only with an order.
 * Zones ordered in the same beat (or before it) are not waiting, so they are not counted.
 */
function warningHoldNote(ctx: StoryContext, beat: Beat): ChapterNote | null {
  const deps = ctx.model.traffic?.zoneDepartures;
  const ordered = new Set(beat.rows.filter((r) => r.family === "order").flatMap((r) => r.zoneIds));
  const warned = [...new Set(beat.rows.filter((r) => r.family === "warning").flatMap((r) => r.zoneIds))];
  if (!deps || warned.length === 0) return null;
  const zones = warned.filter((id) => {
    const at = ctx.insights.get(id)?.orderAtMs ?? null;
    return !ordered.has(id) && !(at !== null && at <= beat.atMs + DECISION_MERGE_MS);
  });
  if (zones.length === 0) return ordered.size === 0 ? alreadyOrderedNote(ctx, beat, warned) : null;
  let veh = 0;
  for (const id of zones) {
    const z = ctx.insights.get(id);
    const first = deps[id]?.atMs[0] ?? null;
    if (first !== null && first < beat.atMs) return null;
    if (first !== null && (z?.orderAtMs == null || first < z.orderAtMs)) return null;
    veh += z?.vehicles ?? 0;
  }
  if (veh <= 0) return null;
  const never = zones.every((id) => ctx.insights.get(id)?.orderAtMs == null);
  const these = zones.length === 1 ? "this area" : "these areas";
  return {
    text:
      `In the model a warning alone sends nobody: the ${fmt(veh)} cars in ${these} leave only once an order comes` +
      (never
        ? `, and the model has no order for ${zones.length === 1 ? "it" : "them"} before its run ends, so they never leave in the model.`
        : ", if one comes."),
    evidence: ctx.model.traffic?.evidenceClass ?? "simulated",
  };
}

/** Zones a beat outlines: its own, else (borrowed) those of other records with the same exact area name. */
function beatZoneIds(ctx: StoryContext, beat: Beat): { ids: string[]; borrowed: boolean } {
  const own = [...new Set(beat.rows.flatMap((r) => r.zoneIds))];
  if (own.length > 0) return { ids: own, borrowed: false };
  // Areas named without a crosswalk of their own ("zones 2, 6, 7") borrow other records' zones;
  // "parts of X" never outlines all of X, and fire, road and other records do not borrow.
  const ids = beat.rows
    .filter((r) => r.family === "order" || r.family === "warning" || r.family === "alert" || r.e.type === "fire_arrival")
    .flatMap((r) => r.names)
    .filter((n) => !/^parts of\b/i.test(n.label))
    .flatMap((n) => [...(ctx.keyZones.get(n.key) ?? [])]);
  return { ids: [...new Set(ids)], borrowed: true };
}

/** A beat as a chapter; core chapters pass their own title and extra lines. */
function beatChapter(
  ctx: StoryContext,
  beat: Beat,
  id: string,
  override: { title?: string; bodyAfter?: string; notesBefore?: ChapterNote[]; notesAfter?: ChapterNote[] } = {},
): Chapter {
  const top = topRow(beat);
  // Records of another evidence class than the lead are told as their own notes, with their own chip.
  const body = beat.rows.filter((r) => r.e.evidenceClass === top.e.evidenceClass);
  const apart = beat.rows.filter((r) => r.e.evidenceClass !== top.e.evidenceClass);
  const hasDecision = body.some((r) => r.family === "order" || r.family === "warning");
  const apartNotes: ChapterNote[] = apart.map((r) => ({
    text:
      r.family === "alert" && hasDecision && Math.abs(r.e.atMs - beat.atMs) < 60_000
        ? "A phone alert went out the same minute."
        : sentence(asSentence(stripTag(r.text))),
    evidence: r.e.evidenceClass,
  }));
  const bodyBeat: Beat = { ...beat, rows: body };
  const ownZones = [...new Set(beat.rows.flatMap((r) => r.zoneIds))];
  const zones = beatZoneIds(ctx, beat);
  const { spot: s, focus } = beatSpot(ctx, beat, zones.ids, zones.borrowed);
  const title = override.title ?? beatTitle(ctx, beat);
  const chapter: Chapter = {
    id,
    atMs: beat.atMs,
    title,
    body: beatSentences(ctx, bodyBeat).join(" ") + (override.bodyAfter ?? ""),
    evidence: top.e.evidenceClass,
    focus,
    spot: s,
    then: dedupeNotes([
      ...apartNotes,
      ...(override.notesBefore ?? []),
      ...beatNotes(ctx, beat, ownZones),
      ...(override.notesAfter ?? []),
    ]),
  };
  TOLD.set(chapter, new Set(beat.rows.map((r) => r.e.id)));
  // Another title when this one repeats an earlier chapter's: the record's bracketed words, a
  // further area under the same name, the order's own launch areas, else the record's time.
  const alts: string[] = [];
  const paren = top.text.match(/\(([^)]{4,40})\)\.?$/)?.[1];
  if (paren && !title.includes(paren)) alts.push(`${title} (${paren})`);
  const more = title.match(/^More of (.+) is ordered to leave$/);
  if (more) alts.push(`A further ${more[1]} area is ordered to leave`);
  const orderZones = [...new Set(beat.rows.filter((r) => r.family === "order").flatMap((r) => r.zoneIds))];
  const zoneLabel = zoneNames(ctx, orderZones, 2);
  if (zoneLabel && !title.includes(zoneLabel)) alts.push(`${title} (${zoneLabel})`);
  alts.push(`${title} (${clock(ctx, beat.atMs, beat.atMs)})`);
  ALT_TITLE.set(chapter, alts);
  return chapter;
}

/**
 * The span the gap filler works in: from the opening (or the start of a later, denser run of
 * decisions) to the modelled traffic peaks, extended to the last decision or fire record within
 * a tail after them.
 */
interface StoryWindow {
  startMs: number;
  endMs: number;
  /** Last modelled traffic peak; gaps after it may be TAIL_GAP_FACTOR larger. */
  peakMs: number;
  /** Largest gap allowed before the peak. */
  maxGapMs: number;
  /** Beats that open and close the window (a later dense run's first decision, the last record); always told. */
  anchors: Beat[];
}

function storyWindow(model: ReplayModel, beats: Beat[], openingMs: number): StoryWindow {
  const decisions = beats.filter((b) => b.rows.some((r) => groupOf(r) === "decision"));
  const episodes: { startMs: number; endMs: number; count: number }[] = [];
  for (const b of decisions) {
    const last = episodes[episodes.length - 1];
    if (last && b.atMs - last.endMs <= EPISODE_SPLIT_MS) {
      last.endMs = b.atMs;
      last.count += 1;
    } else episodes.push({ startMs: b.atMs, endMs: b.atMs, count: 1 });
  }
  let startMs = openingMs;
  const anchors: Beat[] = [];
  const dense = episodes.reduce<(typeof episodes)[number] | null>((best, e) => (!best || e.count > best.count ? e : best), null);
  if (dense && dense !== episodes[0] && dense.count >= DENSE_EPISODE_MIN && dense.startMs > openingMs) {
    startMs = dense.startMs - BEAT_MARGIN_MS;
    const first = decisions.find((b) => b.atMs === dense.startMs);
    if (first) anchors.push(first);
  }
  const metrics = model.traffic?.metrics ?? [];
  let peakMs = startMs;
  for (const key of ["exposedVeh", "enRouteVeh", "blockedVeh"] as const) {
    const k = argmax(metrics.map((m) => m[key]));
    if (k >= 0 && metrics[k][key] >= MIN_HEADLINE_VEH) peakMs = Math.max(peakMs, metrics[k].atMs);
  }
  const active = beats.filter(
    (b) => b.tier <= 4 || b.rows.some((r) => /^evacuation_(?:started|completed)$/.test(r.e.type)),
  );
  const last = active.filter((b) => b.atMs <= peakMs + WINDOW_TAIL_MS).pop();
  const endMs = Math.max(peakMs, last?.atMs ?? peakMs);
  if (last && last.atMs > peakMs) anchors.push(last);
  const scaled = Math.round((endMs - startMs) / GAP_DIVISOR / 60_000) * 60_000;
  return { startMs, endMs, peakMs, maxGapMs: Math.min(MAX_GAP_CAP_MS, Math.max(MAX_GAP_MS, scaled)), anchors };
}

function gapLimit(window: StoryWindow, lo: number): number {
  return lo >= window.peakMs ? window.maxGapMs * TAIL_GAP_FACTOR : window.maxGapMs;
}

/** The gaps between the given times inside the window, with a virtual bound at the window's end. */
function windowGaps(times: number[], window: StoryWindow): { lo: number; hi: number; from: number; to: number }[] {
  const bounds = [...[...times].sort((a, b) => a - b).map((t) => ({ t, real: true })), { t: window.endMs, real: false }].sort(
    (a, b) => a.t - b.t,
  );
  const out: { lo: number; hi: number; from: number; to: number }[] = [];
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    const lo = Math.max(bounds[i].t, window.startMs);
    const hi = Math.min(bounds[i + 1].t, window.endMs);
    if (hi <= lo) continue;
    out.push({
      lo,
      hi,
      from: Math.max(bounds[i].t + BEAT_MARGIN_MS, window.startMs),
      to: Math.min(bounds[i + 1].t - (bounds[i + 1].real ? BEAT_MARGIN_MS : 0), window.endMs),
    });
  }
  return out;
}

/**
 * Fill the window's gaps: repeatedly take the largest gap above the window's limit and add the best
 * unused beat strictly inside it (lowest tier, then nearest the gap's middle), up to MAX_BEATS.
 */
function fillGaps(chapterTimes: number[], beats: Beat[], window: StoryWindow): Beat[] {
  const free = beats.filter((b) => b.atMs >= window.startMs && b.atMs <= window.endMs);
  const chosen: Beat[] = window.anchors.filter(
    (b) => free.includes(b) && chapterTimes.every((t) => Math.abs(t - b.atMs) >= BEAT_MARGIN_MS),
  );
  while (chosen.length < MAX_BEATS) {
    let best: { len: number; pick: Beat } | null = null;
    for (const g of windowGaps([...chapterTimes, ...chosen.map((b) => b.atMs)], window)) {
      const len = g.hi - g.lo;
      if (len <= gapLimit(window, g.lo) || (best && len <= best.len)) continue;
      const mid = (g.lo + g.hi) / 2;
      const inside = free.filter((b) => !chosen.includes(b) && b.atMs >= g.from && b.atMs <= g.to);
      // Prefer the middle half of the gap, so one pick splits it instead of nibbling an end.
      // Mapped orders always count, as does anything in a gap too long for status beats; other
      // records must split the gap or close it, not just trim an end.
      const long = len > gapLimit(window, g.lo) * (MAX_STATUS_PER_GAP + 1);
      const useful = inside.filter((b) => {
        const rest = Math.max(b.atMs - g.lo, g.hi - b.atMs);
        return b.tier === 0 || long || rest <= len * SPLIT_SHARE || rest <= gapLimit(window, g.lo);
      });
      const pick = useful.sort(
        (a, b) => a.tier - b.tier || Math.abs(a.atMs - mid) - Math.abs(b.atMs - mid),
      )[0];
      if (pick) best = { len, pick };
    }
    if (!best) break;
    chosen.push(best.pick);
  }
  return chosen;
}

/**
 * Times for model status beats: a gap still above the limit gets evenly spaced status beats when
 * at most MAX_STATUS_PER_GAP close it; longer gaps are left to a time-skip note.
 */
function statusTimes(ctx: StoryContext, chapterTimes: number[], unused: Beat[], window: StoryWindow): number[] {
  const metrics = ctx.model.traffic?.metrics ?? [];
  if (metrics.length === 0) return [];
  const out: number[] = [];
  const gaps = windowGaps(chapterTimes, window).sort((a, b) => b.hi - b.lo - (a.hi - a.lo));
  for (const g of gaps) {
    const limit = gapLimit(window, g.lo);
    const len = g.hi - g.lo;
    // Status beats never stand in for a record the beat cap left out.
    if (len <= limit * STATUS_GAP_FACTOR || unused.some((b) => b.atMs >= g.from && b.atMs <= g.to)) continue;
    const n = Math.ceil(len / limit) - 1;
    if (n > MAX_STATUS_PER_GAP || out.length + n > MAX_STATUS) continue;
    for (let i = 1; i <= n; i += 1) {
      const m = metricsAt(ctx.model, g.lo + (len * i) / (n + 1));
      if (m && m.atMs >= g.from && m.atMs <= g.to && !out.includes(m.atMs)) out.push(m.atMs);
    }
  }
  return out;
}

/** A chapter that tells where the model stands when the record is silent. */
function statusChapter(ctx: StoryContext, t: number, prevMs: number, nextMs: number): Chapter | null {
  const m = metricsAt(ctx.model, t);
  const traffic = ctx.model.traffic;
  if (!m || !traffic) return null;
  const evidence = traffic.evidenceClass;
  const prev = metricsAt(ctx.model, prevMs);
  const total = m.notDepartedVeh + m.enRouteVeh + m.arrivedVeh;
  const moving = m.blockedVeh - stuckForGood(ctx, frameIndexAt(ctx.model, m.atMs));
  const title =
    m.enRouteVeh === 0 && m.arrivedVeh === 0
      ? "Nobody has left yet (in the model)"
      : moving >= MIN_HEADLINE_VEH && m.blockedVeh * 4 >= m.enRouteVeh
        ? "Traffic backs up (in the model)"
        : prev && m.enRouteVeh > prev.enRouteVeh * 1.1
          ? "Roads filling up (in the model)"
          : prev && m.enRouteVeh < prev.enRouteVeh * 0.9
            ? "Roads emptying (in the model)"
            : "Meanwhile, in the model";
  const quiet = !ctx.model.events.some(
    (e) => e.atMs > prevMs && e.atMs < nextMs && e.evidenceClass !== "simulated" && !isCrosswalk(e),
  );
  const parts = [`${fmt(m.notDepartedVeh)} of ${fmt(total)} cars are still at home`, roadParts(ctx, m)];
  if (m.exposedVeh > 0) parts.push(`${fmt(m.exposedVeh)} are ${exposedPhrase(ctx, t)}`);
  const body =
    `${quiet ? `The bundle records nothing between ${clock(ctx, prevMs, t)} and ${clock(ctx, nextMs, t)}, so this is the model alone. ` : ""}` +
    `In the model at ${clock(ctx, m.atMs, m.atMs)}, ${parts.join("; ")}.`;
  const then: ChapterNote[] = [];
  if (prev && prev.atMs < m.atMs) {
    const left = prev.notDepartedVeh - m.notDepartedVeh;
    const arrived = m.arrivedVeh - prev.arrivedVeh;
    const bits: string[] = [];
    if (left > 0) bits.push(`${fmt(left)} more cars set off`);
    if (arrived > 0) bits.push(`${fmt(arrived)} reached a destination`);
    if (bits.length > 0) {
      then.push({ text: `In the model, since ${clock(ctx, prev.atMs, t)}, ${joinAnd(bits)}.`, evidence });
    }
  }
  const k = frameIndexAt(ctx.model, m.atMs);
  const lines = busyEdgeLines(ctx.model, k, null);
  const s = spot(lines.length > 0 ? "TRAFFIC (MODEL)" : "", { lines });
  return {
    id: `status-${m.atMs}`,
    atMs: m.atMs,
    title,
    body,
    evidence,
    focus: spotCoords(s),
    spot: s,
    then,
  };
}

/** Spell out each glossary acronym once, at its first appearance in the story. */
function explainOnce(chapters: Chapter[]): void {
  const done = new Set<string>();
  // Inside brackets a gloss reads "CAL FIRE, the state fire agency," instead of nesting brackets.
  const apply = (text: string, re: RegExp, to: string) => {
    const at = text.search(re);
    const before = text.slice(0, Math.max(0, at));
    const nested = (before.match(/\(/g)?.length ?? 0) > (before.match(/\)/g)?.length ?? 0);
    return capitalise(text.replace(re, nested ? to.replace(/^(.*?) \((.+)\)$/, "$1, $2,") : to));
  };
  for (const ch of chapters) {
    for (const [term, re, to] of EXPLAIN) {
      if (done.has(term)) continue;
      if (re.test(ch.body)) {
        ch.body = apply(ch.body, re, to);
        done.add(term);
        continue;
      }
      const note = [...(ch.lead ?? []), ...(ch.then ?? [])].find((n) => re.test(n.text));
      if (note) {
        note.text = apply(note.text, re, to);
        done.add(term);
      }
    }
  }
}

/** Lines in a time-skip lead or the closing chapter's summary of the record (the last may count the rest). */
const SKIP_LINES = 6;

/**
 * The record between two chapters (or after the last), dated and grouped so nothing in the
 * bundle is dropped silently: deaths, orders, phone-alert orders, warnings, burnovers, first
 * sightings, shelter changes, blocked roads, fire runs and day-dated entries, at most `max` lines
 * with a last line counting what is not shown. `told` records are left out (another chapter tells
 * them), except orders, which are always counted.
 */
function recordSummary(
  ctx: StoryContext,
  fromMs: number,
  toMs: number,
  told: { chapters: ReadonlySet<string>; linked: ReadonlyMap<string, string[]> },
  max: number,
  withDate: boolean,
): ChapterNote[] {
  const rows = ctx.rows.filter(
    (r) =>
      r.e.atMs > fromMs &&
      r.e.atMs <= toMs &&
      !["fire_ignition", "fire_reported", "perimeter_observed", "road_reopened"].includes(r.e.type),
  );
  if (rows.length === 0) return [];
  const at = (r: RecordRow) =>
    r.e.timePrecision === "day"
      ? `on ${new Intl.DateTimeFormat("en-US", { timeZone: ctx.tz, month: "short", day: "numeric" }).format(r.e.atMs)}`
      : `at ${withDate ? clockWithDate(ctx, r.e.atMs) : clock(ctx, r.e.atMs, toMs)}`;
  // One record in plain words: orders and warnings by the areas they name, else the record's text.
  const quote = (r: RecordRow) => {
    // A log line with more than one statement ("fire 35,000 acres; mandatory evacuation added …") is quoted whole.
    const names = r.names.length > 0 && !/;/.test(stripTag(r.text)) ? formatNames(r.names, 3) : null;
    const what =
      names && r.family === "order" && r.e.type !== "evacuation_order_downgraded" && !STATEMENT_OF_NEED.test(r.text)
        ? `an order to leave for ${names}`
        : names && r.family === "warning"
          ? `a warning to get ready to leave for ${names}`
          : names && r.family === "alert" && r.alertKind === "order"
            ? `a phone alert telling ${names} to leave`
            : names && r.family === "alert"
              ? `a phone alert for ${names}`
              : null;
    return what ? `${capitalise(at(r))}, the record has ${what}.` : `${capitalise(at(r))}, the record has: ${sentence(stripTag(r.text))}`;
  };
  const when = (r: RecordRow) => at(r).replace(/^at /, "");
  // "for Lower Clark (13:34), Nimshew (13:46) and 5 more"
  const listed = (l: RecordRow[], noun: string) => {
    const items = l.slice(0, 3).map((r) => `${r.names.length > 0 ? formatNames(r.names, 2) : sentence(stripTag(r.text), false)} (${when(r)})`);
    if (l.length > 3) items.push(`${l.length - 3} more`);
    return `The record has ${l.length} ${noun}: for ${joinAnd(items)}.`;
  };
  const groups: { rows: RecordRow[]; text: string; firstMs: number }[] = [];
  const used = new Set<RecordRow>();
  const add = (list: RecordRow[], text: (list: RecordRow[]) => string, minGroup = 3) => {
    if (list.length === 0) return;
    list.forEach((r) => used.add(r));
    if (list.length < minGroup) for (const r of list) groups.push({ rows: [r], text: quote(r), firstMs: r.e.atMs });
    else groups.push({ rows: list, text: text(list), firstMs: list[0].e.atMs });
  };
  const fresh = (r: RecordRow) => !told.chapters.has(r.e.id) && !told.linked.has(r.e.id);
  // Orders are left out only when a chapter tells them, or a note gives their clock time, not when
  // a note merely links to them ("… went out 2 hours 50 minutes later").
  const untold = (r: RecordRow) =>
    !told.chapters.has(r.e.id) && !(told.linked.get(r.e.id) ?? []).some((x) => x.includes(clock(ctx, r.e.atMs, r.e.atMs)));
  // A phone alert sent the same minute as an order for the same names is that order's alert.
  const paired = new Set<RecordRow>();
  for (const r of rows) {
    if (r.family !== "alert" || r.alertKind === "order") continue;
    if (rows.some((o) => o.family === "order" && Math.abs(o.e.atMs - r.e.atMs) < 60_000 && [...o.keys].some((k) => r.keys.has(k)))) {
      used.add(r);
      paired.add(r);
    }
  }
  add(rows.filter((r) => r.e.type === "civilian_fatality" && fresh(r)), () => "", Infinity);
  add(
    rows.filter((r) => r.family === "order" && !r.repeat && r.e.type !== "evacuation_order_downgraded" && untold(r)),
    (l) => listed(l, "new orders to leave"),
  );
  // Phone alerts that order people out, each first attempt (a call-back repeat is not a new alert).
  add(
    rows.filter((r) => r.family === "alert" && r.alertKind === "order" && !/recall attempt/i.test(r.e.label) && untold(r)),
    (l) => listed(l, "phone alerts telling people to leave"),
  );
  add(rows.filter((r) => r.family === "warning" && !r.repeat && fresh(r)), (l) => listed(l, "warnings to get ready to leave"), 2);
  add(
    rows.filter((r) => r.e.type === "burnover" && fresh(r)),
    (l) =>
      `The record has ${l.length} burnovers (people overrun by fire): at ${joinAnd([
        ...burnoverPlaces(l.slice(0, 3), true).map((p, i) => `${p} (${when(l[i])})`),
        ...(l.length > 3 ? [`${l.length - 3} more places`] : []),
      ])}.`,
    2,
  );
  add(
    rows.filter((r) => r.e.type === "fire_arrival" && r.names.length > 0 && fresh(r) && !used.has(r)),
    (l) => `Fire was first seen in ${joinAnd([...l.slice(0, 3).map((r) => `${formatNames(r.names, 2)} (${when(r)})`), ...(l.length > 3 ? [`${l.length - 3} more areas`] : [])])}.`,
    2,
  );
  add(rows.filter((r) => /^shelter_(?:opened|closed|full)$/.test(r.e.type) && !/^Temporary refuge|^TRA-/i.test(r.e.label) && fresh(r)), () => "", Infinity);
  add(
    rows.filter((r) => /^road_(?:blocked|closed)$/.test(r.e.type) && fresh(r)),
    (l) => `The record has ${l.length} roads blocked or closed, from ${when(l[0])} to ${when(l[l.length - 1])}; the first: ${sentence(stripTag(l[0].text), false)}.`,
  );
  add(rows.filter((r) => r.family === "fire" && FIRE_JUMP.test(r.text) && !/\bthreaten/i.test(r.text) && fresh(r) && !used.has(r)), () => "", Infinity);
  add(rows.filter((r) => r.e.timePrecision === "day" && fresh(r) && !used.has(r)), () => "", Infinity);
  // Anything else is quoted when there is room, else counted by kind.
  for (const r of rows) if (fresh(r) && !used.has(r)) groups.push({ rows: [r], text: quote(r), firstMs: r.e.atMs });
  const unshown = (kept: typeof groups) => {
    const shown = new Set(kept.flatMap((g) => g.rows));
    return rows.filter((r) => (fresh(r) || used.has(r)) && !shown.has(r) && !paired.has(r));
  };
  let kept = groups.slice(0, max);
  if (unshown(kept).length > 0) kept = groups.slice(0, Math.max(0, max - 1));
  const rest = unshown(kept);
  const out: ChapterNote[] = [...kept]
    .sort((a, b) => a.firstMs - b.firstMs)
    .map((g) => ({ text: g.text, evidence: g.rows[0].e.evidenceClass }));
  if (rest.length > 0) {
    const kinds = new Map<string, { n: number; noun: [string, string] }>();
    // The same change can appear in two source tables (e.g. refuge openings): count it once.
    const seen = new Set<string>();
    for (const r of rest) {
      const key = `${r.e.type}|${r.e.atMs}|${r.e.label.match(/\bTRA-\w+/)?.[0] ?? r.e.destinationId ?? r.e.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const noun = kindNoun(r);
      kinds.set(noun[0], { n: (kinds.get(noun[0])?.n ?? 0) + 1, noun });
    }
    const sorted = [...kinds.values()].sort((a, b) => b.n - a.n);
    const parts = sorted.slice(0, 3).map(({ n, noun }) => `${n} ${noun[n === 1 ? 0 : 1]}`);
    const more = sorted.slice(3).reduce((sum, k) => sum + k.n, 0);
    if (more > 0) parts.push(`${more} more`);
    out.push({ text: `${out.length > 0 ? "Also in that time, not told here" : "In that time the record also has, not told here"}: ${joinAnd(parts)}.`, evidence: "derived" });
  }
  return out;
}

/** A plain noun (singular, plural) for a record left out of a summary ("fire report"). */
function kindNoun(r: RecordRow): [string, string] {
  const t = r.e.type;
  if (/^shelter_/.test(t) && /^Temporary refuge|^TRA-/i.test(r.e.label)) return ["refuge-area record", "refuge-area records"];
  if (r.family === "fire") return ["fire report", "fire reports"];
  if (r.family === "alert") return ["phone alert", "phone alerts"];
  if (r.family === "road") return ["road report", "road reports"];
  if (r.family === "order" || r.family === "warning") return ["repeated order or warning", "repeated orders or warnings"];
  if (/^evacuation_|^facility_/.test(t)) return ["evacuation report", "evacuation reports"];
  if (/^shelter_/.test(t)) return ["shelter report", "shelter reports"];
  return ["other entry", "other entries"];
}

/** Records the chapters tell, and those their notes link to, so summaries do not repeat them. */
function toldIds(chapters: Chapter[]): { chapters: Set<string>; linked: Map<string, string[]> } {
  const out = { chapters: new Set<string>(), linked: new Map<string, string[]>() };
  for (const ch of chapters) {
    for (const id of TOLD.get(ch) ?? []) out.chapters.add(id);
    for (const n of [...(ch.then ?? []), ...(ch.lead ?? [])]) {
      if (n.refId) out.linked.set(n.refId, [...(out.linked.get(n.refId) ?? []), n.text]);
    }
  }
  return out;
}

/**
 * Long jumps between chapters (too long for status beats) get lead-in lines: what the satellite
 * outline did meanwhile, whether an order was recorded, and what else the record has in between.
 */
function skipNotes(ctx: StoryContext, chapters: Chapter[], window: StoryWindow | null): void {
  const model = ctx.model;
  const minMs = Math.max(SKIP_NOTE_MS, (window?.maxGapMs ?? MAX_GAP_MS) * (MAX_STATUS_PER_GAP + 1));
  const told = toldIds(chapters);
  for (let i = 1; i < chapters.length; i += 1) {
    const prev = chapters[i - 1].atMs;
    const ch = chapters[i];
    // The closing chapter summarises its own span.
    if (ch.reveal || ch.id === "epilogue" || chapters[i - 1].id === "people" || ch.atMs - prev < minMs) continue;
    const before = model.perimeters.filter((p) => p.atMs <= prev).pop();
    const after = model.perimeters.filter((p) => p.atMs <= ch.atMs).pop();
    const lead: ChapterNote[] = [];
    // The satellite chapter tells its own outline.
    const grew = after && after !== before && after.areaKm2 != null && after.atMs !== ch.atMs;
    // Any recorded order counts, including phone alerts that order people out.
    const orders = model.events.some(
      (e) =>
        e.evidenceClass !== "simulated" &&
        (e.type === "evacuation_order" || isOrder(e)) &&
        e.atMs > prev &&
        e.atMs < ch.atMs,
    );
    lead.push(
      grew && after?.areaKm2 != null
        ? {
            text:
              `Skipping ahead ${span(prev, ch.atMs)}: in that time the satellite outline ` +
              (before?.areaKm2 != null
                ? `grew from ${before.areaKm2.toFixed(0)} km² to ${after.areaKm2.toFixed(0)} km².`
                : `reached ${after.areaKm2.toFixed(0)} km².`),
            evidence: after.evidenceClass,
          }
        : { text: `Skipping ahead ${span(prev, ch.atMs)}.`, evidence: "derived" },
    );
    if (!orders) lead.push({ text: "The bundle records no new evacuation order in that time.", evidence: "derived" });
    lead.push(...recordSummary(ctx, prev, ch.atMs - 1, told, SKIP_LINES, false));
    ch.lead = [...lead, ...(ch.lead ?? [])];
  }
}

/**
 * How the model fire was fitted and constrained, from fire_simulated's calibration headline and
 * constraint note, in plain words; null when the bundle says neither.
 */
function calibrationLine(ctx: StoryContext): string | null {
  const fs = ctx.model.fireSimulated;
  if (!fs) return null;
  const head = fs.calibrationHeadline ?? "";
  const out: string[] = [];
  // "median arrival error 104 min on 189 held-out NIST observations (17:00-20:00Z); 26 min on 169 calibration observations"
  const held = head.match(/median arrival error (\d+) min on (\d+) held-out [^(]*\((\d\d):(\d\d)-(\d\d):(\d\d)Z\);\s*(\d+) min on (\d+) calibration/i);
  // "median arrival error 10 min from the reported times at 7 places …"
  const reported = head.match(/median arrival error (\d+) min from the reported times at (\d+) places/i);
  const shapeOnly = /\bwith the first perimeter only\b/i.test(head) && /\bno ground observations\b/i.test(head);
  if (held && fs.ignition) {
    const at = (hh: string, mm: string) => {
      const d = new Date(fs.ignition!.atMs);
      let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Number(hh), Number(mm));
      if (t < fs.ignition!.atMs - 12 * 3_600_000) t += 24 * 3_600_000;
      return clock(ctx, t, fs.ignition!.atMs);
    };
    out.push(
      `Its settings were tuned to when fire was first seen at ${held[8]} places before ${at(held[3], held[4])} (median error ${held[7]} minutes); ` +
        `from ${at(held[3], held[4])} to ${at(held[5], held[6])}, at ${held[2]} places it was not tuned to, its arrival times are off by a median of ${held[1]} minutes.`,
    );
  } else if (reported) {
    out.push(
      `Its settings were fitted to the reported fire-arrival times at ${reported[2]} places (median error ${reported[1]} minutes)` +
        (/\bfinal satellite perimeter\b/i.test(head) ? " and to the shape of the final satellite outline." : "."),
    );
  } else if (shapeOnly) {
    out.push(
      `Its settings were fitted only to the shape of that outline${fs.calibrationIou != null ? ` (overlap ${fs.calibrationIou.toFixed(2)} out of 1)` : ""}, ` +
        "with no ground observations of the fire, so its timing before then is model output, not matched to any report.",
    );
  }
  const note = fs.constraintNote ?? "";
  if (/\bfirst satellite perimeter\b/i.test(note)) out.push("It is also kept inside that first satellite outline, which uses later evidence: a reconstruction, not a forecast.");
  else if (/\bfinal\b[^.]*perimeter/i.test(note)) out.push("It is also kept inside the final satellite outline, which uses later evidence: a reconstruction, not a forecast.");
  return out.length > 0 ? ` ${out.join(" ")}` : null;
}

/** Where the model's start point comes from: a record (observed or reported), investigators, or an assumption. */
function startBasis(model: ReplayModel): "recorded" | "reconstructed" | "assumed" {
  const p = model.fireSimulated?.ignition?.provenance ?? "";
  if (/\bplace\b.*\((?:observed|reported)\b/i.test(p)) return "recorded";
  return ignitionBasis(model);
}

/** "12:00 on Nov 9" style clock with the date always shown. */
function clockWithDate(ctx: StoryContext, t: number): string {
  return clock(ctx, t, t - 366 * 24 * 3_600_000);
}

/**
 * The closing chapter: the record after the story's last chapter (dated and grouped), the road
 * closures that end, the fire's last mapped size and where the model ends up.
 */
function epilogueChapter(
  ctx: StoryContext,
  afterMs: number,
  told: { chapters: ReadonlySet<string>; linked: ReadonlyMap<string, string[]> },
  notBeforeMs: number,
): Chapter | null {
  const model = ctx.model;
  const endMs = model.clock.endMs;
  const fixed: ChapterNote[] = [];
  let lastMs = afterMs;
  const reopened = ctx.rows.filter((r) => r.e.type === "road_reopened" && r.e.atMs > afterMs && r.e.atMs <= endMs);
  const later = ctx.rows.filter((r) => r.e.atMs > afterMs && r.e.atMs <= endMs && r.e.type !== "road_reopened");
  for (const r of later) lastMs = Math.max(lastMs, r.e.atMs);
  // The fire's last mapped size, even when an earlier chapter listed it among later outlines.
  const outline = model.perimeters.filter((p) => p.atMs <= endMs).pop();
  if (outline?.areaKm2 != null) {
    fixed.push({
      text: `The last satellite outline in the bundle (${clockWithDate(ctx, outline.atMs)}) covers ${outline.areaKm2.toFixed(0)} km².`,
      evidence: outline.evidenceClass,
    });
    lastMs = Math.max(lastMs, outline.atMs);
  }
  const metrics = model.traffic?.metrics ?? [];
  const end = metrics[metrics.length - 1];
  if (end && end.atMs > afterMs) {
    const never = (model.insights?.zones ?? [])
      .filter((z) => z.orderAtMs === null && (z.vehicles ?? 0) > 0)
      .reduce((s, z) => s + (z.vehicles ?? 0), 0);
    const homeSeries = model.traffic?.extraMetrics.exposed_at_origin_veh ?? [];
    const burnedHome = homeSeries.length > 0 ? (homeSeries[homeSeries.length - 1] ?? 0) : 0;
    const parts: string[] = [];
    if (end.notDepartedVeh > 0) {
      const why: string[] = [];
      if (never > 0) why.push(`${fmt(never)} of them are in areas the model never orders out before its run ends`);
      if (burnedHome > 0) why.push(`${fmt(burnedHome)} are at home inside the area the model counts as burned`);
      parts.push(`${fmt(end.notDepartedVeh)} cars never leave home${why.length > 0 ? ` (${why.join("; ")})` : ""}`);
    }
    if (end.enRouteVeh > 0) {
      parts.push(
        `${fmt(end.enRouteVeh)} cars are still on the road` +
          (end.blockedVeh > 0 ? `, ${end.blockedVeh >= end.enRouteVeh ? "all" : fmt(end.blockedVeh)} of them stuck` : ""),
      );
    }
    if (parts.length > 0) {
      fixed.push({
        text: `In the model at the end of the run (${clockWithDate(ctx, end.atMs)}), ${parts.join("; ")}.`,
        evidence: model.traffic?.evidenceClass ?? "simulated",
      });
    }
  }
  const reopenNote: ChapterNote[] =
    reopened.length > 0
      ? [
          {
            text: `${reopened.length === 1 ? "One road closure ends" : `${reopened.length} road closures end`} by ${clockWithDate(ctx, reopened[reopened.length - 1].e.atMs)}.`,
            evidence: reopened[reopened.length - 1].e.evidenceClass,
          },
        ]
      : [];
  if (reopened.length > 0) lastMs = Math.max(lastMs, reopened[reopened.length - 1].e.atMs);
  const room = Math.max(1, EPILOGUE_NOTES - fixed.length - reopenNote.length);
  const record = recordSummary(ctx, afterMs, endMs, told, room, true);
  const notes = [...record, ...reopenNote, ...fixed];
  if (notes.length === 0) return null;
  const atMs = Math.min(endMs, Math.max(lastMs, notBeforeMs + BEAT_MARGIN_MS));
  const area = outline ?? model.perimeters[model.perimeters.length - 1];
  const hasLater = record.length > 0 || reopenNote.length > 0;
  return {
    id: "epilogue",
    atMs,
    title: "What came after",
    body: hasLater
      ? `The story's window ends here. The record goes on until the replay ends (${clockWithDate(ctx, endMs)}); these are its later entries, then the fire's last mapped size and where the model ends up.`
      : `The story's window ends here; the bundle has no later records before the replay ends (${clockWithDate(ctx, endMs)}). This is the fire's last mapped size and where the model ends up.`,
    evidence: "derived",
    focus: area ? ringCoords(area.geometry) : [],
    spot: area ? spot("LAST SATELLITE OUTLINE", { areas: [area.geometry] }) : spot("", {}),
    then: notes,
  };
}

/** Chapters in clock order. Chapters whose source data is absent are simply left out. */
export function buildChapters(
  model: ReplayModel,
  variants: VariantIndex | null,
  place: ReferencePlace | null,
  mobility: Mobility | null = null,
  /** Households each home dot stands for, to explain the dots in the prologue. */
  perDot: number | null = null,
): Chapter[] {
  const chapters: Chapter[] = [];
  const ctx = storyContext(model, place);
  const roads = ctx.roads;
  const tz = model.incident.timezone;
  const modelled = model.traffic?.evidenceClass ?? "simulated";
  const insightEvidence = model.insights?.evidenceClass ?? "simulated";
  const beats = clusterBeats(ctx.rows.filter(isCandidate));
  const used = new Set<Beat>();
  const beatOf = (e: ReplayEvent) => beats.find((b) => b.rows.some((r) => r.e.id === e.id)) ?? null;
  /** The beat holding `e` as a chapter (marked used), or a one-record beat when it has none. */
  const coreBeat = (e: ReplayEvent): Beat => {
    const b = beatOf(e);
    if (b) {
      used.add(b);
      return b;
    }
    const row = ctx.rows.find((r) => r.e.id === e.id);
    return { atMs: e.atMs, rows: row ? [row] : [], tier: row?.tier ?? 5 };
  };

  const town = place && place.name !== POPULATION_CENTRE ? place : null;
  /** Where the model fire stands against the town, as a model note (never under a record's chip). */
  const fireNote = (t: number): ChapterNote[] => {
    if (!town) return [];
    // Once the model fire is inside the town's mapped areas, a distance to its centre misleads.
    const townZones = [...(ctx.keyZones.get(town.name.toLowerCase()) ?? [])];
    const inside = townZones.some((id) => {
      const at = ctx.insights.get(id)?.fireArrivalAtMs;
      return at != null && at <= t;
    });
    if (inside) {
      return [{ text: `In the model, the fire has already reached the edge of ${town.name} by now.`, evidence: insightEvidence }];
    }
    const fire = buildCaption(model, t, frameIndexAt(model, t), place).fire;
    if (!fire) return [];
    // Caption fragments ("model fire 12.0 km from Paradise") as a full sentence.
    const text = fire
      .replace(/^model fire has/, "the modelled fire has")
      .replace(/^model fire /, "the modelled fire is ")
      .replace(/^satellite perimeter /, "the satellite outline is ")
      .replace(new RegExp(`\\bfrom ${town.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`), `from central ${town.name}`);
    return [{ text: capitalise(`at this moment ${text}.`), evidence: /^satellite/.test(fire) ? "derived" : modelled }];
  };

  // Prologue: where people were before anyone left (Census households; the people layer).
  const zones = model.zones?.items ?? [];
  const households = zones.reduce((sum, z) => sum + (z.households ?? 0), 0);
  const people = model.demand?.population ?? null;
  const startAt = model.fireSimulated?.ignition?.atMs ?? model.clock.startMs;
  if (households > 0) {
    const zoneEvidence = model.zones?.evidenceClass;
    const censusAreas = zones.length > 0 && zones.every((z) => z.id.startsWith("bg:"));
    const where = censusAreas
      ? `the ${fmt(zones.length)} Census block groups the model covers (called neighbourhoods in this story)`
      : `the ${fmt(zones.length)} evacuation zones the bundle maps (order and warning areas)`;
    chapters.push({
      id: "people",
      atMs: Math.max(model.clock.startMs, startAt - 60_000),
      title: censusAreas ? "Who lived in the modelled area" : "Who lived in the evacuation zones",
      body:
        (people != null ? `${fmt(people)} people lived in ${where}, in ` : `Census counts for ${where}: `) +
        `${fmt(households)} households.` +
        (perDot
          ? ` Each grey square is ${perDot === 1 ? "one household" : `${perDot} households`} still at home. ` +
            "It disappears when they leave, and turns amber if the fire reaches it first. " +
            "Squares are spread along each area's streets for illustration; they are not real addresses."
          : " Darker green means more households per km²; watch it drain as people leave.") +
        " What follows is what officials recorded, with the model filling in where nobody was counting.",
      evidence: zoneEvidence && zoneEvidence !== "mixed" ? zoneEvidence : "derived",
      focus: zones.flatMap((z) => ringCoords(z.geometry)),
      spot: spot("", {}),
    });
  }

  // Opening: the first 911 report when the bundle has it, else the ignition record.
  const ignition = firstEvent(model, (e) => e.type === "fire_ignition");
  const reported = firstEvent(
    model,
    (e) => e.type === "fire_reported" && HISTORICAL.has(e.evidenceClass),
  );
  const opening = reported ?? ignition;
  const ignitionCoord = model.fireSimulated?.ignition?.coord ?? null;
  const basis = startBasis(model);
  const order = firstEvent(model, isOrder);
  if (opening) {
    const then: ChapterNote[] = [];
    // A recorded failure just before the first report, told without implying a cause.
    const failure = firstEvent(
      model,
      (e) =>
        e.type === "infrastructure_failure" &&
        HISTORICAL.has(e.evidenceClass) &&
        e.atMs <= opening.atMs &&
        opening.atMs - e.atMs <= 10 * 60_000,
    );
    if (failure) {
      then.push({
        text: `${sentence(plain(failure.label))} The record does not say that one caused the other.`,
        evidence: failure.evidenceClass,
      });
    }
    const first = model.perimeters[0];
    const where =
      basis === "recorded"
        ? "the start point in the record"
        : basis === "reconstructed"
          ? "where investigators place the start"
          : "an assumed starting point";
    then.push({
      text:
        (first
          ? `No outline of the fire exists until the first satellite outline (dated ${clock(ctx, first.atMs, opening.atMs)}), so the orange area is a model of its spread from ${where}.`
          : `Nobody mapped the fire this early, so the orange area is a model of its spread from ${where}.`) +
        (calibrationLine(ctx) ?? ""),
      evidence: model.fireSimulated?.evidenceClass ?? "simulated",
    });
    // What the record has between the first report and the first order (warnings, requests).
    const early = order
      ? ctx.rows.find(
          (r) =>
            (r.family === "warning" || r.e.type === "evacuation_requested") &&
            r.e.atMs > opening.atMs &&
            r.e.atMs < order.atMs - DECISION_MERGE_MS,
        )
      : undefined;
    if (early) {
      then.push({
        text: `First, at ${clock(ctx, early.e.atMs, opening.atMs)}, the record has: ${sentence(stripTag(early.text))}`,
        evidence: early.e.evidenceClass,
      });
    }
    if (order && order.atMs > opening.atMs) {
      then.push({
        text: `The first evacuation order came ${span(opening.atMs, order.atMs)} later, at ${localTime(order.atMs, tz)}.`,
        evidence: order.evidenceClass,
      });
    }
    const label = (e: ReplayEvent) => {
      // "X Fire reported start (Agency)." is the agency's start time, told as a sentence.
      const m = plain(e.label).match(/^(.+?) reported start \(([^)]+)\)\.?$/i);
      return m ? `${m[2]} records the ${m[1]} starting at ${clock(ctx, e.atMs, e.atMs)}.` : sentence(plain(e.label));
    };
    const reportedTitle = !!reported || /\bfirst report\b/i.test(opening.label);
    chapters.push({
      id: "ignition",
      atMs: opening.atMs,
      title: reportedTitle ? "The fire is reported" : "The fire starts",
      body: reported && ignition ? `${label(reported)} ${label(ignition)}` : label(opening),
      evidence: opening.evidenceClass,
      focus: [...(ignitionCoord ? [ignitionCoord] : []), ...(place ? [place.coord] : [])],
      spot: spot(
        ignitionCoord
          ? basis === "reconstructed" ? "WHERE IT STARTED" : basis === "recorded" ? "RECORDED START" : "ASSUMED START"
          : "",
        { points: ignitionCoord ? [ignitionCoord] : [] },
      ),
      then,
    });
  }

  const window = opening ? storyWindow(model, beats, opening.atMs) : null;
  const placeOrderFirst = place
    ? firstEvent(model, (e) => isOrder(e) && e.label.includes(place.name))
    : null;
  const atOnce = order ? allAtOnceLine(variants, order.atMs, tz) : null;

  // The first order always gets a chapter, even when the reference place has a later one.
  if (order) {
    const beat = coreBeat(order);
    const names = beat.rows.filter((r) => r.family === "order" || r.family === "alert").flatMap((r) => r.names);
    const list = names.length > 0 ? formatNames(names, 3) : "";
    // When the story's busy window starts later, the next new order is told here.
    const next = ctx.rows.find(
      (r) =>
        r.family === "order" &&
        !r.repeat &&
        r.e.atMs > beat.atMs + DECISION_MERGE_MS &&
        !beat.rows.includes(r) &&
        r.e.type !== "evacuation_order_downgraded",
    );
    const nextNotes: ChapterNote[] = [];
    if (next && window && next.e.atMs < window.startMs) {
      nextNotes.push({
        text:
          `The next order came ${span(order.atMs, next.e.atMs)} later, at ${clock(ctx, next.e.atMs, order.atMs)}: ` +
          sentence(next.names.length > 0 ? `evacuation order for ${formatNames(next.names, 3, true)}` : lowerFirst(stripTag(next.text))),
        evidence: next.e.evidenceClass,
        refId: next.e.id,
      });
      const dep = next.zoneIds.length > 0 ? departuresNote(ctx, next.zoneIds, next.e.atMs) : null;
      if (dep) nextNotes.push({ text: dep.replace(/ here /, " there "), evidence: modelled });
    }
    chapters.push(
      beatChapter(ctx, beat, "first-order", {
        title: list && list.length <= 40 ? `First evacuation order: ${list}` : "The first evacuation order",
        notesAfter: [...fireNote(order.atMs), ...nextNotes],
      }),
    );
  }

  if (place) {
    const placeOrder = placeOrderFirst;
    if (placeOrder && placeOrder.id !== order?.id && !used.has(beatOf(placeOrder) as Beat)) {
      const beat = coreBeat(placeOrder);
      const zoned = beat.rows.flatMap((r) => r.names).some((n) => n.num && n.prefix === place.name);
      const earlier =
        order && order.atMs < placeOrder.atMs
          ? ` Orders for areas nearer the fire had started ${span(order.atMs, placeOrder.atMs)} earlier.`
          : "";
      chapters.push(
        beatChapter(ctx, beat, "place-order", {
          title: zoned ? `The first parts of ${place.name} are ordered out` : `Officials order ${place.name} out`,
          bodyAfter: earlier,
          notesAfter: fireNote(placeOrder.atMs),
        }),
      );
    }

    // The first documented fire in the place, from the record, and how soon after its first order.
    const arrival = firstEvent(
      model,
      (e) =>
        e.type === "fire_arrival" &&
        HISTORICAL.has(e.evidenceClass) &&
        e.label.includes(place.name),
    );
    if (arrival && !used.has(beatOf(arrival) as Beat)) {
      const gap = placeOrder ? arrival.atMs - placeOrder.atMs : null;
      chapters.push(
        beatChapter(ctx, coreBeat(arrival), "place-fire", {
          title:
            gap !== null && gap >= 0 && placeOrder
              ? `Fire reaches ${place.name} ${span(placeOrder.atMs, arrival.atMs)} after its first order`
              : `Fire reaches ${place.name}`,
          notesAfter: [
            {
              text: "Amber squares are households the model still has at home where the fire has reached.",
              evidence: modelled,
            },
          ],
        }),
      );
    }
  }

  // Modelled entrapments: the first batch, the largest one, and the recorded burnovers.
  const trappedAll = model.events.filter((e) => e.type === "vehicles_trapped");
  if (trappedAll.length > 0) {
    const batches = new Map<number, ReplayEvent[]>();
    for (const e of trappedAll) batches.set(e.atMs, [...(batches.get(e.atMs) ?? []), e]);
    const parse = (list: ReplayEvent[]) => {
      const streets: { name: string; veh: number }[] = [];
      for (const e of list) {
        const m = splitSnappedNote(e.label).text.match(/^Modelled fire entrapment:\s*(.+?)\s*\((\d[\d,]*) veh\)/i);
        if (m) streets.push({ name: m[1], veh: Number(m[2].replace(/,/g, "")) });
      }
      return { streets: streets.sort((a, b) => b.veh - a.veh), veh: streets.reduce((s, x) => s + x.veh, 0) };
    };
    const [firstAt, firstList] = [...batches][0];
    const first = parse(firstList);
    const largest = [...batches]
      .map(([at, list]) => ({ at, ...parse(list) }))
      .sort((a, b) => b.veh - a.veh)[0];
    const burnovers = model.events.filter((e) => e.type === "burnover" && HISTORICAL.has(e.evidenceClass));
    const row = model.validation?.rows.find((r) => r.metric === "identified_burnovers");
    const firstBurnover = burnovers[0]
      ? sentence(plain(burnovers[0].label), false).replace(/^Burnover #\d+ at /i, "")
      : null;
    const lines = firstList.flatMap((e) => eventLines(e, roads));
    // "Most on X" only when X holds more than half of the batch.
    const lead = first.streets[0];
    const where =
      first.streets.length === 0
        ? ""
        : first.streets.length <= 3
          ? ` on ${joinAnd(first.streets.map((s) => s.name))}`
          : ` on ${first.streets.length} streets, ${lead.veh * 2 > first.veh ? "most" : "including some"} on ${lead.name},`;
    const then: ChapterNote[] = [];
    if (largest && largest.at !== firstAt && largest.veh > first.veh) {
      then.push({
        text: `The largest batch in the model comes at ${clock(ctx, largest.at, firstAt)}: ${fmt(largest.veh)} cars on ${largest.streets.length} streets.`,
        evidence: modelled,
      });
    }
    // Cars released by a map-snapshot order (timed at the snapshot, not the real order).
    const snapshot = ctx.rows
      .filter(
        (r) =>
          r.family === "order" &&
          r.e.timePrecision === "approximate" &&
          r.zoneIds.length > 0 &&
          r.e.atMs <= firstAt &&
          firstAt - r.e.atMs <= 3_600_000,
      )
      .filter((r) => zonesOf(ctx, r.zoneIds).some((a) => lines.some((l) => inArea(a, l[Math.floor(l.length / 2)]))));
    if (snapshot.length > 0) {
      then.push({
        text: `In the model these cars set off after the ${clock(ctx, snapshot[0].e.atMs, firstAt)} order, which it times at its map snapshot; the real order may have come earlier.`,
        evidence: modelled,
      });
    }
    if (burnovers.length > 0) {
      const also = row?.caveat?.match(/burnovers also include ([^.;]+)/i)?.[1];
      then.push({
        text:
          `In ${incidentYear(model)}, ${row?.published ?? burnovers.length} burnovers were recorded (people overrun by fire` +
          (also ? `; they also include ${also}` : "") +
          `)${firstBurnover ? `; the first was at ${firstBurnover}` : ""}.`,
        evidence: row?.evidenceClass ?? "reconstructed",
      });
      if (row?.comparability === "tuned") {
        const n = row.model.find((x) => /entrapment_events/.test(x.key))?.value;
        then.push({
          text: `The model's escape limit was tuned against this count${n != null ? ` (it has ${n} fire trappings)` : ""}, so the comparison is not a check.`,
          evidence: "simulated",
        });
      }
    }
    then.push({
      text: "These are modelled cars on roads the fire cut, not a measure of whether anyone survived.",
      evidence: modelled,
    });
    const held = ctx.lastFrontMs !== null && firstAt > ctx.lastFrontMs + 30 * 60_000;
    // The model's own count of cars caught this way, at the end of the run (it rises and falls as roads close).
    const caught = model.traffic?.extraMetrics.trapped_by_fire_veh ?? [];
    const caughtEnd = caught.length > 0 ? (caught[caught.length - 1] ?? 0) : 0;
    chapters.push({
      id: "trapped",
      atMs: firstAt,
      title: "Cars caught by the fire (in the model)",
      body:
        first.veh > 0
          ? (held
              ? `In the model, about ${fmt(first.veh)} cars${where} drive into roads its fire had already cut and find no open road ahead.`
              : `In the model, the fire overtakes about ${fmt(first.veh)} cars${where.replace(/,$/, "")} before they can get clear.`) +
            (caughtEnd > 0 ? ` At the end of the run the model still counts ${fmt(caughtEnd)} cars caught this way.` : "")
          : sentence(splitSnappedNote(firstList[0].label).text),
      evidence: firstList[0].evidenceClass,
      focus: [...lines.flat(), ...fireCoords(model, firstAt)],
      spot: spot("CAUGHT BY FIRE (MODEL)", { lines }),
      then,
    });
  }

  const traffic = model.traffic;

  const contraflow = firstEvent(
    model,
    (e) => e.type === "contraflow_started" && HISTORICAL.has(e.evidenceClass),
  );
  if (contraflow) {
    const m = metricsAt(model, contraflow.atMs);
    const noContraflow = variants?.variants.find((v) => v.id === "no-contraflow");
    const notes: ChapterNote[] = [];
    if (m) {
      const k = frameIndexAt(model, m.atMs);
      const stuck = clearingStuck(ctx, k, m);
      notes.push({
        text:
          `In the model at that moment, across the whole modelled area, ${fmt(m.notDepartedVeh + m.enRouteVeh)} of ` +
          `${fmt(m.notDepartedVeh + m.enRouteVeh + m.arrivedVeh)} cars had not yet got out ` +
          `(${fmt(m.notDepartedVeh)} still at home, ${fmt(m.enRouteVeh)} on the road${stuck > 0 ? `, of which ${fmt(stuck)} were stuck` : ""}).`,
        evidence: modelled,
      });
    }
    if (noContraflow && VARIANT_CAVEATS[noContraflow.id]?.kind === "noise") {
      notes.push({
        text: "Did it help? The model run without contraflow is single-seed and flagged as within noise, so the model cannot say.",
        evidence: "simulated",
      });
    }
    const beat = coreBeat(contraflow);
    const ch = beatChapter(ctx, beat, "contraflow", { notesAfter: notes });
    // The metrics line above replaces the generic one; the road caveat (no segments) stays.
    ch.then = (ch.then ?? []).filter((n) => !/^In the model at \d/.test(n.text));
    chapters.push(ch);
  }

  const blocked = firstEvent(
    model,
    (e) =>
      e.type === "road_blocked" && HISTORICAL.has(e.evidenceClass) && /fire|burning/i.test(e.label),
  );
  if (blocked) {
    chapters.push(beatChapter(ctx, coreBeat(blocked), "road-blocked", { title: "Fire cuts an escape road" }));
  }

  // The busiest moment on the road, told inside the worst-exposure chapter when the two are close.
  const busiest = traffic && traffic.metrics.length > 0 ? argmax(traffic.metrics.map((m) => m.enRouteVeh)) : -1;
  const busy = busiest >= 0 && traffic ? traffic.metrics[busiest] : null;
  let busyTold = false;

  if (traffic && traffic.metrics.length > 0) {
    const k = argmax(traffic.metrics.map((m) => m.exposedVeh));
    const m = traffic.metrics[k];
    if (m.exposedVeh >= MIN_HEADLINE_VEH) {
      const busyLines = busyEdgeLines(model, k, fireAt(model, m.atMs));
      const then: ChapterNote[] = [];
      // Fire before order, from credible zone rows only; zones where the model fire starts are left
      // out of both counts, and a lead time of a few minutes is "about the same time".
      const ordered = trustedRows(ctx, (model.insights?.zones ?? []).filter((z) => z.orderAtMs !== null));
      const starts = ordered.filter((z) => startsThere(ctx, z)).length;
      const rest = ordered.filter((z) => !startsThere(ctx, z));
      const late = rest.filter((z) => z.leadTimeS !== null && z.leadTimeS * 1000 <= -MIN_DELAY_MS);
      if (late.length > 0) {
        const noun = ordered.every((z) => z.zoneId.startsWith("bg:")) ? "neighbourhoods" : "areas";
        const leads = late.map((z) => -(z.leadTimeS ?? 0) * 1000);
        const lo = Math.min(...leads);
        const hi = Math.max(...leads);
        const none = late.every((z) => (z.departedByFireVeh ?? 0) === 0);
        // Zones where the record says the model fire came implausibly early are counted out loud.
        const doubtful = late.filter((z) => earlyFireCaveat(ctx, [z], m.atMs) !== null).length;
        then.push({
          text:
            `In the model, the fire reached ${fmt(late.length)} of the ${fmt(rest.length)} ordered ${noun} with homes ` +
            `before their order` +
            (starts > 0 ? ` (not counting ${starts} where the model fire starts)` : "") +
            (lo === hi ? `, ${duration(lo)} before it` : `, from ${duration(lo)} to ${duration(hi)} before it`) +
            (none ? `; in those ${noun} no modelled car had left before the fire arrived.` : "; cars there set off only after their order.") +
            (doubtful > 0
              ? ` In ${doubtful === late.length ? (late.length === 1 ? "that one" : `all ${late.length}`) : `${doubtful} of them`}, the record has fire arriving much later than the model, so those timings are doubtful.`
              : ""),
          evidence: insightEvidence,
        });
      }
      // The longest jam; one still standing when the replay ends is said to be.
      const lastFrame = traffic.frames[traffic.frames.length - 1];
      const jam = model.insights?.bottlenecks.find((b) => b.name && b.minutesCongested);
      if (jam?.name && jam.minutesCongested) {
        const i = traffic.edgeIds.indexOf(jam.edgeId);
        const standing = lastFrame.edges.some(([index, veh]) => index === i && veh > 0);
        then.push({
          text: standing
            ? `The longest jam in the model, on ${jam.name}, is still congested when the replay ends, after ${duration(jam.minutesCongested * 60_000)}.`
            : `The longest jam in the model is on ${jam.name}, congested for ${duration(jam.minutesCongested * 60_000)}.`,
          evidence: insightEvidence,
        });
      }
      const where = exposedPhrase(ctx, m.atMs);
      if (where !== "on roads the fire has reached" && ctx.lastFrontMs !== null) {
        // A held model fire: its area against the satellite outline on the map, and who it leaves out.
        const front = model.fireSimulated?.fronts[model.fireSimulated.fronts.length - 1];
        const p = perimeterIndexAt(model, m.atMs);
        const outline = p >= 0 ? model.perimeters[p] : null;
        const bits: string[] = [];
        if (front?.areaKm2 != null && outline?.areaKm2 != null && outline.areaKm2 > front.areaKm2 * 1.2) {
          bits.push(
            `The model's burned area is its extent at ${clock(ctx, front.atMs, m.atMs)} (${front.areaKm2.toFixed(0)} km²), ` +
              `smaller than the ${outline.areaKm2.toFixed(0)} km² satellite outline on the map, so cars outside it are not counted`,
          );
        }
        if (bits.length > 0) then.push({ text: `${bits.join("; ")}.`, evidence: modelled });
        // A peak right after a map-snapshot order releases cars from areas the model fire reached long before.
        const snap = ctx.rows.find(
          (r) =>
            r.family === "order" &&
            r.e.timePrecision === "approximate" &&
            r.e.atMs <= m.atMs &&
            m.atMs - r.e.atMs <= 3 * 3_600_000 &&
            r.zoneIds.some((id) => {
              const z = ctx.insights.get(id);
              return !!z && z.leadTimeS !== null && z.leadTimeS < -MAX_LEAD_S;
            }),
        );
        if (snap) {
          then.push({
            text: `This peak follows the ${clock(ctx, snap.e.atMs, m.atMs)} map-snapshot order, which in the model releases cars from areas its fire had reached many hours before.`,
            evidence: modelled,
          });
        }
      }
      // Cars still at home inside the fire area are a separate count: at this moment, and at their own peak.
      const homeSeries = traffic.extraMetrics.exposed_at_origin_veh ?? [];
      const home = homeSeries[k] ?? null;
      const homePeakK = argmax(homeSeries.map((x) => x ?? 0));
      const homePeak = homePeakK >= 0 ? (homeSeries[homePeakK] ?? 0) : 0;
      if (home != null && home > 0) {
        then.push({
          text:
            `This counts only cars on the road. At this moment another ${fmt(home)} cars wait at home inside the area the model counts as burned` +
            (homePeak > m.exposedVeh && homePeakK !== k
              ? `; the most at home there at once is ${fmt(homePeak)}, at ${clock(ctx, traffic.metrics[homePeakK].atMs, m.atMs)}.`
              : "."),
          evidence: modelled,
        });
      }
      const busyHere = !!busy && Math.abs(busy.atMs - m.atMs) <= 45 * 60_000 && busy.enRouteVeh >= MIN_HEADLINE_VEH;
      if (busyHere) busyTold = true;
      const roadsReached = where === "on roads the fire has reached";
      chapters.push({
        id: "peak-exposure",
        atMs: m.atMs,
        title: roadsReached ? "Most cars on roads the fire has reached (in the model)" : "Most cars on roads in the burned area (in the model)",
        body:
          `In the model, ${fmt(m.exposedVeh)} cars are driving ${where}, the most at any moment of the run, and ` +
          `${fmt(m.notDepartedVeh + m.enRouteVeh)} of ${fmt(m.notDepartedVeh + m.enRouteVeh + m.arrivedVeh)} ` +
          `have not got out yet (${fmt(m.notDepartedVeh)} still at home, ${fmt(m.enRouteVeh)} on the road).` +
          (roadsReached
            ? ""
            : ` The model's fire stops spreading at ${clock(ctx, ctx.lastFrontMs ?? m.atMs, m.atMs)} and its area is held after that.`) +
          (busyHere && busy ? ` It is also about the model's busiest moment on the road: ${fmt(busy.enRouteVeh)} cars at ${clock(ctx, busy.atMs, m.atMs)}.` : ""),
        evidence: traffic.evidenceClass,
        focus: [...busyLines.flat(), ...(place ? [place.coord] : [])],
        spot: spot(where === "on roads the fire has reached" ? "CARS WHERE THE FIRE IS (MODEL)" : "CARS IN THE BURNED AREA (MODEL)", { lines: busyLines }),
        then,
      });
    }
  }

  const perimeter = model.perimeters[0];
  if (perimeter) {
    const windowEnd = perimeterWindowEnd(model, 0);
    const later = model.perimeters
      .slice(1)
      .filter((p) => p.areaKm2 != null && p.atMs - perimeter.atMs <= 24 * 3_600_000);
    // The model fire is drawn until hazard_until, else until this outline's window ends (timeline.ts).
    const until = model.fireSimulated ? (model.fireSimulated.hazardUntilMs ?? windowEnd ?? perimeter.atMs) : perimeter.atMs;
    const switchLine =
      until > perimeter.atMs
        ? ` The model fire stays on the map until ${clock(ctx, until, perimeter.atMs)}; after that the map shows the satellite outlines.`
        : " From here the map shows this outline instead of the model fire.";
    const datedAll = later.some((p) => clockParts(p.atMs, tz).date !== clockParts(perimeter.atMs, tz).date);
    const notes: ChapterNote[] = [];
    if (later.length > 0 && perimeter.areaKm2 != null) {
      notes.push({
        text:
          `Later outlines: ${joinAnd(later.map((p) => `${p.areaKm2?.toFixed(0)} km² (${datedAll ? clockWithDate(ctx, p.atMs) : clock(ctx, p.atMs, perimeter.atMs)})`))}. ` +
          "Between outlines the spread is not observed.",
        evidence: later[0].evidenceClass,
      });
    }
    if (model.insights && model.fireSimulated) {
      // The traffic model's fire area switches to the outlines (bundle.py's fire_area_at); arrival times do not.
      const switchMs = model.fireSimulated.hazardUntilMs ?? perimeter.atMs;
      notes.push({
        text:
          "Fire-arrival times in this story's order notes still come from the model fire" +
          (traffic ? `; from ${clock(ctx, switchMs, perimeter.atMs)} the model's roads and homes use the satellite outlines as the fire area.` : "."),
        evidence: "simulated",
      });
    }
    chapters.push({
      id: "satellite",
      atMs: perimeter.atMs,
      // The outline combines passes up to its window's end, so the area is "burned by" then, not now.
      title:
        `First satellite outline${perimeter.areaKm2 != null ? `: ${perimeter.areaKm2.toFixed(0)} km² burned` : ""}` +
        (perimeter.areaKm2 != null && windowEnd !== null ? ` by ${clock(ctx, windowEnd, perimeter.atMs)}` : ""),
      body:
        (windowEnd !== null
          ? `The dotted line combines satellite passes from ${clock(ctx, perimeter.atMs, perimeter.atMs)} to ${clock(ctx, windowEnd, perimeter.atMs)}, ` +
            "so it shows the area burned at some time in that window, not necessarily now."
          : "The dashed line is the satellite estimate of the area burned.") + switchLine,
      evidence: perimeter.evidenceClass,
      focus: ringCoords(perimeter.geometry),
      spot: spot("FIRST SATELLITE OUTLINE", { areas: [perimeter.geometry] }),
      then: notes,
    });
  }

  // Generic beats for bundles without the place-specific ones (e.g. multi-town fires).
  if (!chapters.some((c) => c.id === "place-fire")) {
    const arrival = firstEvent(
      model,
      (e) => e.type === "fire_arrival" && HISTORICAL.has(e.evidenceClass),
    );
    if (arrival && !used.has(beatOf(arrival) as Beat)) {
      const orderRow = order ? ctx.rows.find((r) => r.e.id === order.id) : undefined;
      const orderNames = orderRow && orderRow.names.length > 0 ? ` (for ${formatNames(orderRow.names, 2)})` : "";
      // Places the report names that no order had named yet.
      const unordered = mentionedKeys(ctx, plain(arrival.label)).filter(
        (k) => !ctx.rows.some((r) => r.family === "order" && r.e.atMs <= arrival.atMs && r.keys.has(k)),
      );
      const unorderedName = unordered.length > 0 ? ctx.rows.flatMap((r) => r.names).find((n) => n.key === unordered[0])?.label : undefined;
      // "First reports fire near homes" only when no earlier record mentions homes or structures;
      // else the record's own words, with the earlier mention (the same place first) as a note.
      const HOMES = /\b(?:homes?|houses?|structures?|residences?|subdivisions?)\b/i;
      const keys = mentionedKeys(ctx, plain(arrival.label));
      const earlier = ctx.rows.filter(
        (r) => r.e.atMs < arrival.atMs && r.e.id !== arrival.id && HOMES.test(r.text) && r.family === "fire",
      );
      const nearHomes = earlier.find((r) => mentionedKeys(ctx, r.text).some((k) => keys.includes(k))) ?? earlier[0];
      chapters.push(
        beatChapter(ctx, coreBeat(arrival), "fire-arrival", {
          title: nearHomes ? (shortTitle(plain(arrival.label)) ?? "Fire reported near homes") : "The record first reports fire near homes",
          notesBefore: [
            ...(nearHomes
              ? [recordQuote(ctx, nearHomes, arrival.atMs)]
              : []),
            ...(order
            ? [
                {
                  text:
                    order.atMs > arrival.atMs
                      ? `No one had been ordered out yet: the first evacuation order came ${span(arrival.atMs, order.atMs)} later.`
                      : `The first evacuation order${orderNames} had gone out ${span(order.atMs, arrival.atMs)} earlier` +
                        (unorderedName ? `; the bundle has no order naming ${unorderedName} before this.` : "."),
                  evidence: order.evidenceClass,
                  refId: order.atMs > arrival.atMs ? order.id : undefined,
                },
              ]
            : []),
          ],
        }),
      );
    }
  }
  if (busy && !busyTold && busy.enRouteVeh >= MIN_HEADLINE_VEH && traffic) {
    const busyLines = busyEdgeLines(model, busiest, null);
    // The latest order for an area not ordered before (not a later alert or re-issue for it).
    const lastOrder = [...ctx.rows]
      .reverse()
      .find((r) => r.e.atMs <= busy.atMs && isOrder(r.e) && r.family === "order" && !r.repeat);
    const zoneVeh = lastOrder
      ? lastOrder.zoneIds.reduce((s, id) => s + (ctx.insights.get(id)?.vehicles ?? 0), 0)
      : 0;
    const stuck = clearingStuck(ctx, busiest, busy);
    chapters.push({
      id: "peak-traffic",
      atMs: busy.atMs,
      title: "Most cars on the road at once (in the model)",
      body:
        `At the busiest moment in the model, ${fmt(busy.enRouteVeh)} cars are on the road at once` +
        (stuck > 0 ? `, of which ${fmt(stuck)} are stuck.` : "."),
      evidence: traffic.evidenceClass,
      focus: busyLines.flat(),
      spot: spot("BUSIEST ROADS (MODEL)", { lines: busyLines }),
      then: lastOrder
        ? [
            {
              text:
                `The latest new order before this came ${span(lastOrder.e.atMs, busy.atMs)} earlier: ` +
                sentence(lastOrder.names.length > 0 ? `evacuation order for ${formatNames(lastOrder.names, 4)}` : stripTag(lastOrder.text)),
              evidence: lastOrder.e.evidenceClass,
              refId: lastOrder.e.id,
            },
            ...(zoneVeh > 0
              ? [
                  {
                    // Names the order itself: the record line above is dropped when another chapter tells it.
                    text:
                      `In the model the ${lastOrder.zoneIds.length === 1 ? "area" : `${lastOrder.zoneIds.length} areas`} under the ` +
                      `${clock(ctx, lastOrder.e.atMs, busy.atMs)} order` +
                      (lastOrder.names.length > 0 ? ` for ${formatNames(lastOrder.names, 3)}` : "") +
                      ` hold ${fmt(zoneVeh)} cars, and cars set off only after their area is ordered.`,
                    evidence: modelled,
                  },
                ]
              : []),
          ]
        : [],
    });
  }
  // The most stuck cars, when that moment is far from every other modelled peak and the stuck
  // cars there are not ones that never clear (those are told once, as a model limitation).
  if (traffic && traffic.metrics.length > 0) {
    const k = argmax(traffic.metrics.map((m) => m.blockedVeh));
    const m = traffic.metrics[k];
    const near = chapters.some((c) => Math.abs(c.atMs - m.atMs) <= 45 * 60_000);
    const clearing = m.blockedVeh - stuckForGood(ctx, k);
    if (clearing >= MIN_HEADLINE_VEH && !near) {
      const jammed = busyEdgeLines(model, k, null, true);
      chapters.push({
        id: "peak-blocked",
        atMs: m.atMs,
        title: "Traffic stalls (in the model)",
        body:
          `At this moment the model has its most stuck cars: ${fmt(clearing)} cannot move for now, ` +
          `${fmt(m.enRouteVeh)} are on the road in all and ${fmt(m.notDepartedVeh)} are still at home.`,
        evidence: traffic.evidenceClass,
        focus: jammed.flat(),
        spot: spot("STUCK (MODEL)", { lines: jammed }),
      });
    }
  }
  // The first place to go; a shelter at the same moment as another chapter is told there.
  const shelter = firstEvent(
    model,
    (e) =>
      e.type === "shelter_opened" &&
      HISTORICAL.has(e.evidenceClass) &&
      e.timePrecision !== "day" &&
      !/^Temporary refuge|^TRA-/i.test(e.label),
  );
  if (shelter) {
    coreBeat(shelter);
    const text = sentence(plain(shelter.label));
    const host = chapters.find((c) => !c.reveal && Math.abs(c.atMs - shelter.atMs) < BEAT_MARGIN_MS);
    const others = model.events.filter(
      (e) => e !== shelter && e.type === "shelter_opened" && HISTORICAL.has(e.evidenceClass) && Math.abs(e.atMs - shelter.atMs) < 60_000,
    );
    const lines = [text, ...others.map((e) => sentence(plain(e.label)))];
    // A later closure (or a full house) of the same place, matched by its proper-noun words.
    const words = (x: string) => new Set((plain(x).match(/\b[A-Z][a-z]{2,}\b/g) ?? []).filter((w) => !/^(?:Emergency|Log|The|Center|Centre|Evacuation)$/.test(w)));
    const mine = words(shelter.label);
    const closed = model.events.find(
      (e) =>
        /^shelter_(?:closed|full)$/.test(e.type) &&
        HISTORICAL.has(e.evidenceClass) &&
        e.atMs > shelter.atMs &&
        [...words(e.label)].filter((w) => mine.has(w)).length >= 2,
    );
    const closedNote: ChapterNote[] = [];
    const unlog = (label: string) => sentence(capitalise(stripTag(plain(label)).replace(/^[\w ]+ log:\s*/i, "")));
    if (closed) {
      const instead = model.events.find(
        (e) => e.type === "shelter_opened" && HISTORICAL.has(e.evidenceClass) && Math.abs(e.atMs - closed.atMs) < 60_000,
      );
      closedNote.push({
        text: `Later, at ${clock(ctx, closed.atMs, shelter.atMs)}, the record has: ${unlog(closed.label)}${instead ? ` ${unlog(instead.label)}` : ""}`,
        evidence: closed.evidenceClass,
        refId: closed.id,
      });
    }
    if (host) {
      host.then = [...(host.then ?? []), ...lines.map((x) => ({ text: x, evidence: shelter.evidenceClass })), ...closedNote];
    } else {
      const shelterAt = model.destinations?.items.find((d) => d.id === shelter.destinationId)?.coord ?? null;
      const points = shelterAt ? [shelterAt] : namedPlaces(ctx, lines.join(" "));
      chapters.push({
        id: "shelter",
        atMs: shelter.atMs,
        title: shortTitle(plain(shelter.label)) ?? "A place to go",
        body: lines.join(" "),
        evidence: shelter.evidenceClass,
        focus: points,
        spot: spot(points.length > 0 ? "SHELTER" : "", { points }),
        then: closedNote,
      });
    }
  }
  // The first temporary refuge area (where people sheltered from the fire in place), once.
  const refuge = firstEvent(
    model,
    (e) => e.type === "shelter_opened" && HISTORICAL.has(e.evidenceClass) && /^Temporary refuge/i.test(e.label),
  );
  if (refuge && (!window || refuge.atMs <= window.endMs)) {
    const row = model.validation?.rows.find((r) => r.metric === "identified_tras");
    const withCars = row?.model.find((x) => /tras_with_arrivals/.test(x.key))?.value;
    const then: ChapterNote[] = [];
    if (row?.published != null) {
      then.push({ text: `The record identifies ${row.published} temporary refuge areas in all.`, evidence: row.evidenceClass ?? refuge.evidenceClass });
    }
    if (row && /fallback/i.test(row.caveat ?? "")) {
      then.push({
        text: `In the model, refuge areas are used only as a fallback when no exit can be reached${withCars != null ? `; ${withCars} of them receive cars` : ""}.`,
        evidence: "simulated",
      });
    }
    const at = model.destinations?.items.find((d) => d.id === refuge.destinationId)?.coord ?? null;
    const points = at ? [at] : namedPlaces(ctx, refuge.label);
    chapters.push({
      id: "refuge",
      atMs: refuge.atMs,
      title: "A first temporary refuge area forms",
      body: sentence(plain(refuge.label)),
      evidence: refuge.evidenceClass,
      focus: [...points, ...fireCoords(model, refuge.atMs)],
      spot: spot(points.length > 0 ? "REFUGE AREA" : "", { points }),
      then,
    });
  }

  if (window) {
    // Must-tell records inside the window, whatever the gaps: civilian deaths, every mapped order
    // that sets modelled areas moving, mapped warnings for areas never ordered, and runs of fire
    // reports. They may sit a minute from another chapter.
    const mustTell = beats.filter((b) => {
      if (used.has(b) || b.atMs < window.startMs || b.atMs > window.endMs) return false;
      return b.rows.some((r) => {
        if (r.e.type === "civilian_fatality") return true;
        if (r.family === "order" && r.e.type !== "evacuation_order_downgraded" && r.zoneIds.length > 0) {
          return r.zoneIds.some((id) => {
            const at = ctx.insights.get(id)?.orderAtMs;
            return at != null && Math.abs(at - r.e.atMs) <= DECISION_MERGE_MS;
          });
        }
        if (r.family === "warning" && r.zoneIds.length > 0) {
          return r.zoneIds.some((id) => {
            const z = ctx.insights.get(id);
            return !!z && z.orderAtMs === null && (z.vehicles ?? 0) > 0;
          });
        }
        return false;
      }) || b.rows.filter((r) => /^(?:fire_arrival|fire_status_report)$/.test(r.e.type) && r.names.length === 0).length >= 2;
    });
    for (const b of mustTell) {
      if (chapters.some((c) => !c.reveal && Math.abs(c.atMs - b.atMs) < MUST_TELL_MARGIN_MS)) {
        // Same minute as a chapter: told there as notes.
        const host = chapters.find((c) => !c.reveal && Math.abs(c.atMs - b.atMs) < MUST_TELL_MARGIN_MS);
        if (host) host.then = [...(host.then ?? []), ...b.rows.map((r) => ({ text: sentence(asSentence(stripTag(r.text))), evidence: r.e.evidenceClass }))];
      } else chapters.push(beatChapter(ctx, b, `beat-${b.rows[0].e.id}`));
      used.add(b);
    }
    // Fill the active window's gaps with record beats (orders, alerts, fire, roads).
    const unused = beats.filter((b) => !used.has(b));
    const added = fillGaps(
      chapters.map((c) => c.atMs),
      unused,
      window,
    );
    for (const b of added) chapters.push(beatChapter(ctx, b, `beat-${b.rows[0].e.id}`));
    // Gaps the record cannot fill get short model status beats.
    const times = chapters.map((c) => c.atMs);
    for (const t of statusTimes(ctx, times, unused.filter((b) => !added.includes(b)), window).sort((x, y) => x - y)) {
      const prevMs = Math.max(...times.filter((x) => x < t));
      const nextMs = Math.min(...times.filter((x) => x > t), window.endMs);
      const ch = statusChapter(ctx, t, prevMs, nextMs);
      if (!ch) continue;
      chapters.push(ch);
      times.push(ch.atMs);
    }
  }

  // The epilogue picks up the record after the last chapter (the mobility chapter included); what
  // falls between the last record chapter and a later mobility chapter is that chapter's skip lead.
  const emptied = mobilityChapter(ctx, mobility);
  if (emptied) chapters.push(emptied);

  chapters.sort((a, b) => a.atMs - b.atMs);
  const lastMs = chapters[chapters.length - 1]?.atMs ?? model.clock.startMs;
  const epilogue = epilogueChapter(ctx, lastMs, toldIds(chapters), lastMs);
  if (epilogue) chapters.push(epilogue);
  skipNotes(ctx, chapters, window);
  finishChapters(ctx, chapters);

  if (variants && revealRows(variants).length > 0) {
    const peak = chapters.find((c) => c.id === "peak-exposure");
    const firstOrder = chapters.find((c) => c.id === "first-order");
    chapters.push({
      id: "what-if",
      // The map sits at the modelled worst moment while the alternatives are compared.
      atMs: peak?.atMs ?? chapters[chapters.length - 1]?.atMs ?? model.clock.startMs,
      title: "Could it have gone differently?",
      body:
        "Each bar re-runs the same modelled morning with one thing changed. A shorter bar means " +
        "fewer car-minutes inside the modelled fire, on the road or still at home. Model experiments, not history " +
        "and not advice; runs flagged as noise or model artifacts are not shown.",
      evidence: "simulated",
      focus: peak?.focus ?? firstOrder?.focus ?? [],
      spot: peak?.spot ?? spot("", {}),
      then: atOnce ? [{ text: atOnce, evidence: "simulated" }] : [],
      reveal: true,
    });
  }
  explainOnce(chapters);
  return chapters;
}

/**
 * Story-wide clean-up once chapters are in clock order: forward links to records another chapter
 * tells, the warning explanation and the never-clearing stuck cars told once, the Everbridge name,
 * repeated titles, and the note cap.
 */
function finishChapters(ctx: StoryContext, chapters: Chapter[]): void {
  const toldBy = new Map<string, Chapter>();
  for (const ch of chapters) for (const id of TOLD.get(ch) ?? []) if (!toldBy.has(id)) toldBy.set(id, ch);
  let warnedOnce = false;
  for (const ch of chapters) {
    ch.then = (ch.then ?? []).filter((n) => {
      const other = n.refId ? toldBy.get(n.refId) : undefined;
      return !other || other === ch;
    });
    ch.then = ch.then.map((n) => {
      if (!/^In the model a warning alone sends nobody: /.test(n.text)) return n;
      if (!warnedOnce) {
        warnedOnce = true;
        return n;
      }
      return { ...n, text: n.text.replace(/^In the model a warning alone sends nobody: the ([\d,]+) cars in (this area|these areas) leave only once an order comes/, "In the model the $1 cars in $2 wait for an order before leaving") };
    });
  }
  // Stuck cars that never clear: said once, as a limitation, where the model's traffic peaks.
  const residue = stuckResidue(ctx);
  if (residue) {
    const host =
      chapters.find((c) => c.id === "peak-traffic" && c.atMs >= residue.atMs) ??
      chapters.find((c) => c.id === "peak-exposure" && c.atMs >= residue.atMs) ??
      chapters.find((c) => !c.reveal && c.id !== "people" && c.atMs >= residue.atMs);
    const end = ctx.model.traffic?.metrics[ctx.model.traffic.metrics.length - 1];
    if (host && end) {
      host.then = [
        ...(host.then ?? []),
        {
          text:
            `In the model ${fmt(residue.veh)} cars are still stuck when the run ends (${clockWithDate(ctx, end.atMs)}) and never get out. ` +
            "That is a limitation of the model, not a finding, so stuck counts here leave out cars that never clear.",
          evidence: ctx.model.traffic?.evidenceClass ?? "simulated",
        },
      ];
    }
  }
  // A model note told word for word in the chapter just before, about the same mapped place, is not
  // told again; record lines already quoted ("… the record has: …") are not quoted again either.
  const quoted = new Set<string>();
  for (let i = 0; i < chapters.length; i += 1) {
    const ch = chapters[i];
    const prev = chapters[i - 1];
    const samePlace = !!prev && ch.focus.length > 0 && prev.focus.length === ch.focus.length && prev.spot.areas.length === ch.spot.areas.length;
    const prevSaid = new Set((prev?.then ?? []).filter((n) => n.evidence === "simulated").map((n) => n.text));
    ch.then = (ch.then ?? []).filter((n) => {
      if (n.evidence === "simulated") return !(samePlace && prevSaid.has(n.text));
      if (!n.refId || !/the record has:/.test(n.text)) return true;
      if (quoted.has(n.refId)) return false;
      quoted.add(n.refId);
      return true;
    });
  }
  // The same road lines as the chapter before are not drawn again (the camera keeps its frame).
  const lineKey = (c: Chapter) => {
    const ls = c.spot.lines;
    return ls.length === 0 ? "" : `${ls.length}:${ls[0][0]?.join(",")}:${ls[ls.length - 1][0]?.join(",")}`;
  };
  let lastLines = "";
  for (const ch of chapters) {
    if (ch.reveal) continue;
    const key = lineKey(ch);
    if (key && key === lastLines) {
      const kept = { ...ch.spot, lines: [] };
      ch.spot = kept.points.length > 0 || kept.areas.length > 0 ? spot(ch.spot.label, kept) : spot("", {});
    }
    if (key) lastLines = key;
  }
  // The prologue promises amber squares; where no chapter explains them, the first one that can does.
  const homeSeries = ctx.model.traffic?.extraMetrics.exposed_at_origin_veh ?? [];
  const firstHome = homeSeries.findIndex((x) => (x ?? 0) > 0);
  const promised = chapters.some((c) => c.id === "people" && /\bamber\b/.test(c.body));
  const explained = chapters.some((c) => (c.then ?? []).some((n) => /^Amber squares\b/.test(n.text)));
  if (promised && !explained && firstHome >= 0 && ctx.model.traffic) {
    const atMs = ctx.model.traffic.metrics[firstHome].atMs;
    const host = chapters.find((c) => !c.reveal && c.id !== "people" && c.atMs >= atMs && (c.then ?? []).length < MAX_NOTES);
    if (host) {
      const k = frameIndexAt(ctx.model, host.atMs);
      const n = homeSeries[k] ?? 0;
      // Where the record contradicts the model fire's early arrival, the at-home count says so.
      const reached = [...ctx.insights.values()].filter((z) => z.fireArrivalAtMs !== null && z.fireArrivalAtMs <= host.atMs);
      const caveat = n > 0 ? earlyFireCaveat(ctx, reached, host.atMs) : null;
      host.then = [
        ...(host.then ?? []),
        {
          text:
            (n > 0 ? `In the model at ${clock(ctx, host.atMs, host.atMs)}, ${fmt(n)} cars are still at home inside the area it counts as burned. ` : "") +
            (caveat ? `${caveat} ` : "") +
            "Amber squares are households the model still has at home where the fire has reached.",
          evidence: ctx.model.traffic.evidenceClass,
        },
      ];
    }
  }
  // Phone alerts sent through Everbridge: the system named once.
  if (ctx.rows.some((r) => r.family === "alert" && /^Everbridge\b/i.test(r.e.label))) {
    for (const ch of chapters) {
      if (/\b[Aa] phone alert\b/.test(ch.body)) {
        ch.body = ch.body.replace(/\b([Aa] phone alert)\b/, "$1 (sent through Everbridge, a mass-notification system)");
        break;
      }
    }
  }
  const seen = new Set<string>();
  for (const ch of chapters) {
    ch.title = capitalise(ch.title.replace(/\bCHP\b/g, "the Highway Patrol"));
    if (seen.has(ch.title)) {
      // Never "…, again": the later record may cover a different area.
      const alt = (ALT_TITLE.get(ch) ?? []).map((t) => capitalise(t.replace(/\bCHP\b/g, "the Highway Patrol"))).find((t) => !seen.has(t));
      ch.title = alt ?? `${ch.title} (${clock(ctx, ch.atMs, ch.atMs)})`;
    }
    seen.add(ch.title);
    ch.then = capNotes(ch.then ?? [], ch.id === "epilogue" ? EPILOGUE_NOTES : MAX_NOTES);
  }
}

/** At most `max` notes: record notes first in their order, keeping up to two model notes at the end. */
function capNotes(notes: ChapterNote[], max: number): ChapterNote[] {
  if (notes.length <= max) return notes;
  const model = notes.filter((n) => n.evidence === "simulated").slice(-2);
  const record = notes.filter((n) => !model.includes(n));
  const keep = new Set([...record.slice(0, max - model.length), ...model]);
  return notes.filter((n) => keep.has(n));
}

/**
 * Featurable variants (not flagged as artifact, noise or worse at home) with a combined-exposure headline,
 * lowest exposure first.
 */
export function revealRows(index: VariantIndex): RevealRow[] {
  const rows: RevealRow[] = [];
  for (const v of index.variants) {
    // A road-only gain bought with worse exposure at home is not a result to feature here;
    // the What if… tab shows it with the full road / home breakdown.
    if (!featurable(v.id) || VARIANT_CAVEATS[v.id]?.kind === "worse-at-home") continue;
    const h = v.headline.total_exposed_veh_min;
    if (!h || h.baseline == null || h.variant == null || h.baseline <= 0) continue;
    const a = v.headline.arrived_by_1800z_veh;
    rows.push({
      id: v.id,
      title: v.title,
      question: v.question,
      exposurePct: (h.variant / h.baseline) * 100,
      arrivedBaseline: a?.baseline ?? null,
      arrivedVariant: a?.variant ?? null,
    });
  }
  return rows.sort((a, b) => a.exposurePct - b.exposurePct);
}
