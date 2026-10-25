// Wire types for the live API (docs/live-reports.md v2, ADR 0011 and 0012). Keep in step with
// the contract and mobile/CrisisTwin/Features/Live/LiveModels.swift.
// Times are UTC ISO 8601 strings with `Z`. Coordinates are WGS84 [lon, lat]. Distances are meters.
// "Drill time" fields (replay_*) are 2018 Camp Fire replay times; everything else is wall time.

import type { DrillInject } from './injects'

export type LonLat = [lon: number, lat: number]
export type IsoTime = string

export interface PolygonGeometry {
  type: 'Polygon'
  coordinates: LonLat[][]
}
export interface MultiPolygonGeometry {
  type: 'MultiPolygon'
  coordinates: LonLat[][][]
}
export type AreaGeometry = PolygonGeometry | MultiPolygonGeometry

// ---- v1: reports, road state, public map, tasks ----

export type LiveRole = 'civilian' | 'responder' | 'controller'
export type ReportKind =
  | 'road_blocked'
  | 'road_passable'
  | 'heavy_traffic'
  | 'fire_seen'
  | 'heavy_smoke'
  | 'hazard_down'
  | 'shelter_full'
  | 'help_needed'
export type ReportSeverity = 'full' | 'partial' | 'slow'
export type ReportStatus = 'unverified' | 'corroborated' | 'responder_confirmed' | 'confirmed' | 'dismissed' | 'resolved' | 'withdrawn'

export interface RoadRef {
  segment_id: string
  name: string
  snap_m: number | null
}

export type ReportMethod = 'explicit' | 'passive'
export type SpeedClass = 'stopped' | 'slow' | 'moving'

/** A reporter's earlier values of an edited report (docs/live-reports.md); `at` is when they were replaced. */
export interface ReportRevision {
  at: IsoTime
  kind: ReportKind
  severity: ReportSeverity | null
  location: { coord: LonLat; accuracy_m: number | null }
  note: string | null
  destination_id: string | null
}

export interface FieldReport {
  id: string
  client_id: string
  incident_id: string
  reporter: { role: LiveRole; party_key: string }
  kind: ReportKind
  severity: ReportSeverity | null
  location: { coord: LonLat; accuracy_m: number | null }
  heading_deg: number | null
  road_ref: RoadRef | null
  destination_id: string | null
  task_id: string | null
  observed_at: IsoTime
  received_at: IsoTime
  note: string | null
  status: ReportStatus
  /** `historical_record`: a 2018 911 / radio entry entered at its drill time; counts only once confirmed. */
  evidence_class: 'field_report' | 'drill_fixture' | 'historical_record'
  /** Set on `historical_record` reports. */
  record?: { id: string; channel: string; source_locator: string | null } | null
  /** v2: drill time at received_at; null when no drill ran. */
  replay_at: IsoTime | null
  /** ADR 0041: `passive` reports come from phone motion, not a person; absent on older servers. */
  method?: ReportMethod
  speed_class?: SpeedClass | null
  /** The reporter edited this report (docs/live-reports.md). Absent on servers that predate edits. */
  edited_at?: IsoTime | null
  /** Set with `status: 'withdrawn'`: the reporter took the report back. Treated as closed. */
  withdrawn_at?: IsoTime | null
  /** Earlier values, oldest first, at most 10. */
  revisions?: ReportRevision[]
}

export interface PublicMapItem {
  id: string
  kind: ReportKind
  severity: ReportSeverity | null
  coord: LonLat
  road_ref: RoadRef | null
  line: LonLat[] | null
  independent_parties: number
  responder_reports: number
  controller_confirmed: boolean
  confidence: number
  /** ADR 0041: distinct phones whose motion supports the item. */
  passive_parties?: number
  first_reported_at: IsoTime
  last_observed_at: IsoTime
  /** Controller views only (command): the reports behind the item and its destination (shelter_full). */
  report_ids?: string[]
  destination_id?: string | null
}

export type RoadStatus = 'open' | 'slow' | 'blocked' | 'unknown'
export interface RoadStateItem {
  segment_id: string
  name: string | null
  status: RoadStatus
  confidence: number
  independent_parties: number
  passive_parties?: number
  responder_reports: number
  last_observed_at: IsoTime
  report_ids: string[]
  decided_by: string | null
  public: boolean
}

export type TaskStatus = 'open' | 'accepted' | 'done' | 'cancelled'
export interface CheckTask {
  id: string
  incident_id: string
  /** Responder party_key, or null for any responder (v2). */
  assignee: string | null
  /** `assist`: go to a resident who asked for help (`checkin_id`); closed with `done`. */
  kind: 'verify' | 'assist'
  checkin_id?: string | null
  target: { segment_id?: string | null; coord?: LonLat | null }
  report_ids: string[]
  note: string | null
  created_at: IsoTime
  status: TaskStatus
  /** ADR 0041 task board fields; absent on older servers. */
  created_by?: 'controller' | 'priority' | string
  question?: string | null
  place?: string | null
  expires_at?: IsoTime | null
  priority?: number | null
  answers?: TaskAnswers | null
}

export interface TaskAnswers {
  road_passable: number
  road_blocked: number
  heavy_traffic: number
  shelter_full: number
  passive: number
  total: number
  last_at: IsoTime | null
}

export type PriorityKind = 'segment' | 'destination' | 'gateway'
/** One row of `command.stale_critical`: an item ranked by impact x change x staleness. */
export interface PriorityItem {
  id: string
  kind: PriorityKind
  name: string
  coord: LonLat
  /** Null unless a segment. */
  line: LonLat[] | null
  segment_id: string | null
  destination_id: string | null
  zone_id: string | null
  priority: number
  impact: number
  p_change: number
  staleness: number
  vehicles: number | null
  zones: number | null
  zones_losing_route: number | null
  load: number | null
  households: number | null
  spread_ratio: number | null
  fire_distance_m: number | null
  half_life_s: number | null
  last_observed_at: IsoTime | null
  reason: string
  task_id: string | null
}

export type TriageAction = 'confirm' | 'dismiss' | 'merge' | 'resolve'
export interface TriageRequest {
  action: TriageAction
  into?: string
  note?: string
}

export interface CreateTaskRequest {
  assignee: string | null
  target: { segment_id?: string; coord?: LonLat }
  report_ids: string[]
  note?: string
  /** `assist`: send a responder to a person (help reports); default `verify`. */
  kind?: 'verify' | 'assist'
}

// ---- v2: drill clock ----

export interface DrillState {
  incident_id: string
  label: string
  replay_now: IsoTime
  replay_start: IsoTime
  started_at: IsoTime | null
  /** Drill seconds per wall second, 0..60; 0 pauses. */
  speed: number
  running: boolean
  clock: { start: IsoTime; end: IsoTime }
}

export type DrillRequest =
  | { action: 'start'; replay_start?: IsoTime; speed?: number }
  | { action: 'reset' }
  | { action: 'set_speed'; speed: number }

export interface DrillResponse {
  drill: DrillState
}

// ---- v2: fire estimate (current best estimate, never a forecast) ----

export type FireMethod = 'satellite_perimeter' | 'model_nowcast' | 'none'
export interface FireObservation {
  coord: LonLat
  at: IsoTime
  source: 'nist_reconstructed' | 'field_report'
}
export interface FireEstimate {
  /** Drill time of the source geometry; null when method is none. */
  as_of: IsoTime | null
  method: FireMethod
  label: string
  geometry: MultiPolygonGeometry | null
  observations: FireObservation[]
  evidence_class: 'reconstructed' | 'simulated' | 'none'
}

// ---- v2: zones, destinations, guidance ----

export interface LiveZone {
  id: string
  name: string
  geometry: AreaGeometry
}
export interface CommandZone extends LiveZone {
  households: number
  vehicles: number
}

export type DestinationKind = 'exit' | 'shelter' | 'temporary_refuge'
export interface GuidanceDestination {
  id: string
  name: string
  kind: DestinationKind
  coord: LonLat
}
export interface Destination extends GuidanceDestination {
  capacity_veh: number | null
}

export interface GuidanceRoute {
  line: LonLat[]
  /** Up to 3 road names, in route order. */
  via: string[]
  distance_m: number
  /** Free-flow minutes, integer, rounded up. */
  eta_min: number
  /** How the route relates to the fire estimate; absent from older servers. */
  safety?: RouteSafety
}

export type RouteSafety = 'clear' | 'passes_near_fire' | 'passes_fire'

/** One destination a person may choose (D1). The controller's pick has `recommended: true`. */
export interface GuidanceAlternative {
  destination: GuidanceDestination
  route: GuidanceRoute
  safety: RouteSafety
  /** Share of capacity already heading there, 0..1; null when unknown. */
  load: number | null
  recommended: boolean
}

/** Civilian destination preferences per zone, for the controller (D1). */
/** One `live_decisions` audit entry. `actor` is "controller" or "auto_policy". */
export interface Decision {
  at: string
  actor: string
  /** confirm|dismiss|merge|resolve|task_create|task_cancel|approve|reject|auto_approve|drill_*|help_acknowledge|help_assign|help_resolve */
  action: string
  report_ids: string[]
  proposal_id: string | null
  checkin_id: string | null
  note: string | null
}

export interface DestinationPreferenceCount {
  zone_id: string
  destination_id: string
  count: number
}

export type GuidanceLevel = 'evacuate_now' | 'be_ready' | 'none'
export type ReasonCode = 'fire_within_evacuate_km' | 'fire_within_ready_km' | 'no_open_route' | 'clear'

/** Planner output for one zone, before publishing (proposal change `to`). */
export interface ProposedGuidance {
  level: GuidanceLevel
  destination: GuidanceDestination | null
  route: GuidanceRoute | null
  no_route: boolean
  reason: string
  reason_code: ReasonCode
  /** Plain-language warning when every option passes the fire. */
  caveat?: string | null
  /** Recommended destination plus up to 3 alternatives; absent or empty when there is no choice. */
  alternatives?: GuidanceAlternative[]
}

export interface ZoneGuidance extends ProposedGuidance {
  zone_id: string
  /** Per zone, starts at 1. */
  version: number
  published_at: IsoTime
  /** Drill time the plan was computed for. */
  replay_at: IsoTime
  approved_by: 'auto_policy' | 'controller'
  proposal_id: string
}

// ---- v2: proposals ----

export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'auto_approved' | 'superseded'
export type ChangeKind = 'reroute' | 'route_lost' | 'level_change' | 'new' | 'cleared'
/** road_block: controller- or responder-backed; road_report: crowd-only (never auto-approved). */
export type PlanCause = 'road_block' | 'road_report' | 'fire' | 'shelter_full' | 'manual'

export interface GuidanceSummary {
  level: GuidanceLevel
  destination_id: string | null
  via: string[]
}

export interface ProposalChange {
  zone_id: string
  kind: ChangeKind
  from: GuidanceSummary | null
  /** In `command`, without `route.line` and `alternatives` (kept small for the 5 s poll). */
  to: ProposedGuidance
}

export interface ProposalTask {
  target: { segment_id?: string | null; coord: LonLat }
  reason: string
  report_ids: string[]
  assignee: string | null
}

export interface Rationale {
  text: string
  /** "llm:<model>" or "template". */
  generated_by: string
  evidence_class: 'ai_generated' | 'template'
}

// ---- Controllers (docs/live-reports.md "Controllers"); all twin values are simulated ----

export interface ControllerInfo {
  id: 'rule' | 'twin' | string
  version: string
  /** Why the twin was not used: twin_warming, twin_failed, twin_busy, ...; null when it was. */
  fallback: string | null
}

export interface TwinMetrics {
  arrived_in_window_veh: number
  total_exposed_veh_min: number
  blocked_at_horizon_veh: number
  trapped_by_fire_at_horizon_veh: number
  remaining_at_horizon_veh: number
}

export interface TwinCandidate {
  label: string
  destinations: Record<string, string>
  valid: boolean
  cost: number | null
  metrics: TwinMetrics | null
  errors: unknown[]
}

export interface TwinEvidence {
  evidence_class: 'simulated'
  from: IsoTime
  until: IsoTime
  horizon_min: number
  fire_ahead: 'frozen' | 'replay'
  seed: number
  objective: { name: string; formula: string; weights: Record<string, number>; min_gain_veh_min: number }
  baseline: { label: string; cost: number; metrics: TwinMetrics }
  candidates: TwinCandidate[]
  chosen: number
  reference: number
  orders: string[]
  runtime_ms: number
  limitations: string[]
}

export interface Proposal {
  id: string
  incident_id: string
  created_at: IsoTime
  replay_at: IsoTime
  status: ProposalStatus
  policy: 'auto_reroute' | 'needs_controller'
  causes: PlanCause[]
  /** Segments newly blocked since the previous plan. */
  cause_segment_ids?: string[]
  inputs: {
    fire_as_of: IsoTime | null
    fire_method: FireMethod
    blocked_segment_ids: string[]
    full_destination_ids?: string[]
    planner_version: string
  }
  changes: ProposalChange[]
  tasks: ProposalTask[]
  rationale: Rationale
  controller?: ControllerInfo
  twin?: TwinEvidence | null
  decided_at: IsoTime | null
  /** Drill time of the decision; null outside a drill. */
  decided_replay_at?: IsoTime | null
  decided_by: 'auto_policy' | 'controller' | null
  note: string | null
  /** The pending proposal this approved part was split from (partial approval). */
  parent_id?: string | null
}

export interface ReplanResponse {
  proposal: Proposal | null
  auto_approved: Proposal | null
  detail?: 'no_changes'
}
export interface DecideProposalRequest {
  note?: string
}
export interface ApproveProposalRequest extends DecideProposalRequest {
  /** Approve only these zones' changes; a non-empty subset of the proposal's. */
  zone_ids?: string[]
}
export interface ApproveProposalResponse {
  proposal: Proposal
  guidance: ZoneGuidance[]
  tasks: CheckTask[]
}
export interface RejectProposalResponse {
  proposal: Proposal
}

// ---- v2: check-ins and responders ----

export type CheckInStatus = 'out' | 'need_help' | 'staying'
export interface CheckIn {
  id: string
  status: CheckInStatus
  zone_id: string | null
  /** Only for need_help. */
  coord: LonLat | null
  at: IsoTime
  replay_at: IsoTime | null
}
export interface ZoneCheckInCounts {
  zone_id: string
  out: number
  need_help: number
  staying: number
}
/** Controller handling of a need_help check-in (`POST checkins/{id}/help`). */
export type HelpStatus = 'open' | 'acknowledged' | 'assigned' | 'resolved'
export type HelpAction = 'acknowledge' | 'assign' | 'resolve'
export interface HelpState {
  status: HelpStatus
  /** Responder party_key of the assist task, or null for any responder. */
  assignee: string | null
  task_id: string | null
  updated_at: IsoTime | null
}

export interface HelpRequest {
  id: string
  zone_id: string | null
  coord: LonLat | null
  at: IsoTime
  help: HelpState | null
}
export interface ResponderPosition {
  party_key: string
  /** Simulated responder (ADR 0038): shown with a "sim" tag. */
  simulated?: boolean
  coord: LonLat
  accuracy_m: number | null
  at: IsoTime
}

// ---- v2: command (web controller poll) ----

export interface IncidentInfo {
  id: string
  name: string
  mode: 'live' | 'exercise' | string
}

export interface CommandResponse {
  incident_id: string
  generated_at: IsoTime
  incident?: IncidentInfo
  drill: DrillState
  fire: FireEstimate
  zones_version: string
  zones: CommandZone[]
  destinations: Destination[]
  guidance: ZoneGuidance[]
  /** Live civilian destination choices per zone (D1); absent from older servers. */
  destination_preferences?: DestinationPreferenceCount[]
  /** Newest 50 entries of the controller audit log, newest first. */
  decisions?: Decision[]
  response_record?: ResponseRecordItem[]
  ground_record?: GroundRecord
  /** Drill injects (instructor panel), any status; absent from older servers. */
  injects?: DrillInject[]
  /** Zones with no phone signal now (a comms_outage inject is active). */
  no_signal_zone_ids?: string[]
  /** All pending plus the latest 20 decided, newest first. */
  proposals: Proposal[]
  /** Newest 500. */
  reports: FieldReport[]
  road_state: RoadStateItem[]
  public_items: PublicMapItem[]
  checkins: { by_zone: ZoneCheckInCounts[]; need_help: HelpRequest[] }
  responders: ResponderPosition[]
  tasks: CheckTask[]
  /** ADR 0041; absent on older servers. */
  stale_critical?: PriorityItem[]
  board_computed_at?: IsoTime | null
}

// ---- Traffic twin monitor (docs/twin-api.md "HTTP adapter"); all values simulated ----

export interface TwinTotals {
  total_veh: number
  not_departed_veh: number
  en_route_veh: number
  arrived_veh: number
  blocked_veh: number
  exposed_veh: number
  exposed_at_origin_veh: number
  trapped_by_fire_veh: number
  trapped_by_closure_veh: number
  exposed_veh_min_so_far: number
}

export interface TwinZone {
  id: string
  vehicles: number
  ordered_at: IsoTime | null
  not_departed_veh: number
  en_route_veh: number
  arrived_veh: number
  blocked_veh: number
  exposed_veh: number
  exposed_at_origin_veh: number
  assignment: { destination_id: string } | null
}

export interface TwinEdge {
  edge_index: number
  edge_id: string
  segment_id: string
  name: string | null
  veh: number
  queued_veh: number
  speed_kph: number
  free_flow_kph: number
  coord: LonLat
}

export interface TwinDestination {
  id: string
  name: string
  kind: DestinationKind | string
  status: string
  arrived_veh: number
  capacity_veh: number | null
  remaining_capacity_veh: number | null
  arrived_last_10_min_veh: number
  full_at: IsoTime | null
  assigned_zones: number
}

export interface TwinCommand {
  id: string
  type: string
  label: string | null
  effective_at: IsoTime | null
  status: string
  actor: unknown
  rationale: string | null
}

export interface TwinMonitor {
  kind: 'crisistwin_live_twin'
  incident_id: string
  evidence_class: 'simulated'
  label: string
  drill_replay_now: IsoTime
  clock: { now: IsoTime; start: IsoTime; end: IsoTime; step_s: number; finished: boolean }
  model: { id: string; version: string; seed: number; inputs_fingerprint: string }
  built_from: IsoTime
  totals: TwinTotals
  conserved: boolean
  zones: TwinZone[]
  congested_edges: TwinEdge[]
  /** Every occupied directed edge (simplified line, travel direction), most vehicles first. Simulated. */
  traffic?: TwinTrafficEdge[]
  destinations: TwinDestination[]
  closed_edges: number
  commands: TwinCommand[]
  command_errors: { key: string; error: string; code: string | null; detail: string | null }[]
  limitations: string[]
}

export interface LiveApiError {
  error: string
  detail?: string
  /** Task route errors (409 no_origin) carry `reason` instead of `error`. */
  reason?: string
}

/** GET tasks/{id}/route (docs/live-reports.md "Responder route to a task"); planner route, twin congestion simulated. */
export interface TaskRoute {
  task_id: string
  route: {
    line: LonLat[]
    via: string[]
    distance_m: number
    eta_min: number
    exposure: 'clear' | 'near_fire'
    congestion: 'twin' | 'unavailable'
    congested_edges: number
  } | null
  reason: 'unreachable' | 'no_origin' | null
  detail: string | null
  evidence_class: string
  as_of: IsoTime
}

// ---- Impact analysis (docs/live-reports.md "Impact analysis"); planner routes computed, twin values simulated ----

export interface ImpactRequest {
  segment_id?: string
  report_id?: string
  /** Twin what-if horizon, simulated minutes, (0, 120]; default 60. */
  horizon_min?: number
}

export type ImpactChange = 'slower' | 'rerouted' | 'route_lost' | 'exposed' | 'unchanged'

export interface ImpactOption {
  destination: GuidanceDestination
  route: GuidanceRoute
  /** Least-exposure route through or near the fire estimate. */
  exposed: boolean
}

export interface ImpactZone {
  zone_id: string
  name: string
  level: GuidanceLevel
  households: number
  vehicles: number
  /** Twin: vehicles not yet arrived at the fork; null without the twin. Simulated. */
  vehicles_remaining: number | null
  change: ImpactChange
  /** Blocked minus unblocked free-flow ETA, minutes; null when either has no route. */
  eta_delta_min: number | null
  unblocked: ImpactOption | null
  blocked: ImpactOption | null
}

export interface ImpactTwin {
  evidence_class: 'simulated'
  from: IsoTime
  until: IsoTime
  horizon_min: number
  fire_ahead: 'frozen' | 'replay'
  seed: number
  blocked: TwinMetrics
  unblocked: TwinMetrics
  /** blocked minus unblocked. */
  delta: TwinMetrics
  limitations: string[]
}

export interface ImpactResponse {
  incident_id: string
  generated_at: IsoTime
  replay_at: IsoTime
  target: {
    segment_id: string
    name: string
    line: LonLat[]
    coord: LonLat
    /** Whether the segment is closed now (in guidance and the twin). */
    state: 'blocked' | 'open'
    report_ids: string[]
  }
  planner_version: string
  summary: {
    affected_zones: number
    eta_delta_min: number | null
    zones_losing_route: number
    zones_exposed: number
    vehicles_at_risk: number
    /** twin: not-yet-arrived vehicles of the affected zones (simulated); bundle: their total vehicles. */
    vehicles_at_risk_source: 'twin' | 'bundle'
  }
  zones: ImpactZone[]
  twin: ImpactTwin | null
  /** Why there is no twin part: twin_warming, twin_busy, twin_finished, twin_error:<code>, ... */
  twin_fallback: string | null
  runtime_ms: number
}

/** `twin.traffic`: simulated vehicles on one directed road edge right now. */
export interface TwinTrafficEdge {
  line: LonLat[]
  veh: number
  queued_veh: number
  speed_kph: number
  free_flow_kph: number
}

/** One event of the historical 2018 response record (bundle events that are not simulated). Not a drill action. */
export interface ResponseRecordItem {
  id: string
  at: IsoTime
  type: string
  label: string
  /** reconstructed | reported | derived (never simulated). */
  evidence_class: string
  source_id: string | null
  source_url: string | null
  time_precision: string | null
  zone_ids: string[]
  segment_ids: string[]
}

/** `command.ground_record`: the 2018 911 / radio / rescue record up to drill time, de-identified
 * (template summaries, placed by zone only). Historical, `reported`; never drill reports. */
export type GroundChannel = '911' | 'radio' | 'rescue' | 'notification' | 'evacuation'
export interface GroundRecordItem {
  id: string
  at: IsoTime
  time_precision: string | null
  channel: GroundChannel
  category: string
  road_name: string | null
  summary: string
  evidence_class: string
  source_locator: string | null
  zone_id: string | null
}
export interface GroundRecord {
  available: boolean
  label: string
  window_min: number
  until: IsoTime
  totals: Record<GroundChannel, number>
  window: Record<GroundChannel, number>
  zones: { zone_id: string; items: number; help: number; fire: number }[]
  items: GroundRecordItem[]
}
