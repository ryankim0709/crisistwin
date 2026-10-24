// Wire types for the live API (docs/live-reports.md v2, ADR 0011 and 0012). Keep in step with
// the contract and mobile/CrisisTwin/Features/Live/LiveModels.swift.
// Times are UTC ISO 8601 strings with `Z`. Coordinates are WGS84 [lon, lat]. Distances are meters.
// "Drill time" fields (replay_*) are 2018 Camp Fire replay times; everything else is wall time.

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
export type ReportStatus = 'unverified' | 'corroborated' | 'responder_confirmed' | 'confirmed' | 'dismissed' | 'resolved'

export interface RoadRef {
  segment_id: string
  name: string
  snap_m: number | null
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
  evidence_class: 'field_report'
  /** v2: drill time at received_at; null when no drill ran. */
  replay_at: IsoTime | null
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
  first_reported_at: IsoTime
  last_observed_at: IsoTime
}

export type RoadStatus = 'open' | 'slow' | 'blocked' | 'unknown'
export interface RoadStateItem {
  segment_id: string
  name: string | null
  status: RoadStatus
  confidence: number
  independent_parties: number
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
  kind: 'verify'
  target: { segment_id?: string | null; coord?: LonLat | null }
  report_ids: string[]
  note: string | null
  created_at: IsoTime
  status: TaskStatus
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
export type ChangeKind = 'reroute' | 'level_change' | 'new' | 'cleared'
export type PlanCause = 'road_block' | 'fire' | 'manual'

export interface GuidanceSummary {
  level: GuidanceLevel
  destination_id: string | null
  via: string[]
}

export interface ProposalChange {
  zone_id: string
  kind: ChangeKind
  from: GuidanceSummary | null
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

export interface Proposal {
  id: string
  incident_id: string
  created_at: IsoTime
  replay_at: IsoTime
  status: ProposalStatus
  policy: 'auto_reroute' | 'needs_controller'
  causes: PlanCause[]
  inputs: {
    fire_as_of: IsoTime | null
    fire_method: FireMethod
    blocked_segment_ids: string[]
    planner_version: string
  }
  changes: ProposalChange[]
  tasks: ProposalTask[]
  rationale: Rationale
  decided_at: IsoTime | null
  decided_by: 'auto_policy' | 'controller' | null
  note: string | null
}

export interface ReplanResponse {
  proposal: Proposal | null
  auto_approved: Proposal | null
  detail?: 'no_changes'
}
export interface DecideProposalRequest {
  note?: string
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
export interface HelpRequest {
  id: string
  zone_id: string | null
  coord: LonLat | null
  at: IsoTime
}
export interface ResponderPosition {
  party_key: string
  coord: LonLat
  accuracy_m: number | null
  at: IsoTime
}

// ---- v2: command (web controller poll) ----

export interface CommandResponse {
  incident_id: string
  generated_at: IsoTime
  drill: DrillState
  fire: FireEstimate
  zones_version: string
  zones: CommandZone[]
  destinations: Destination[]
  guidance: ZoneGuidance[]
  /** All pending plus the latest 20 decided, newest first. */
  proposals: Proposal[]
  /** Newest 500. */
  reports: FieldReport[]
  road_state: RoadStateItem[]
  public_items: PublicMapItem[]
  checkins: { by_zone: ZoneCheckInCounts[]; need_help: HelpRequest[] }
  responders: ResponderPosition[]
  tasks: CheckTask[]
}

export interface LiveApiError {
  error: string
  detail?: string
}
