// Response of GET /api/live/incidents/{id}/aar (docs/live-reports.md "After-action report").
export interface AarComponent {
  id: string;
  label: string;
  evidence_class: "simulated" | "observed" | "historical";
  raw: number | null;
  unit: string;
  score: number | null;
  weight: number;
  effective_weight: number | null;
  points: number | null;
  rule: string;
}

export interface AarZone {
  zone_id: string;
  name: string;
  vehicles: number;
  guidance_changes: number;
  first_leave_now_at: string | null;
  historical_order_at: string | null;
  leave_now_vs_2018_min: number | null;
  leave_now_status: "none" | "earlier" | "later" | "same" | "missed";
  reports: number;
  triage_median_min: number | null;
  help_requests: number;
  help_to_assign_median_min: number | null;
  arrived_veh?: number;
  exposed_veh?: number;
}

export interface AarTimelineEntry {
  at: string;
  drill_at: string | null;
  actor: string;
  action: string;
  report_ids: string[];
  proposal_id: string | null;
  checkin_id: string | null;
  note: string | null;
}

export interface AarResponse {
  kind: "crisistwin_live_aar";
  incident_id: string;
  generated_at: string;
  drill: { replay_start: string; replay_now: string; started_at: string | null; speed: number; running: boolean };
  score: { value: number | null; max: number; coverage: number; components: AarComponent[]; formula: string };
  twin: {
    status: string;
    detail?: string;
    clock?: string | null;
    totals: {
      total_veh: number;
      arrived_veh: number;
      exposed_veh: number;
      trapped_by_fire_veh: number;
      exposed_veh_min_so_far: number;
    } | null;
  };
  zones: AarZone[];
  triage: { reports: number; triaged: number; median_min: number | null };
  help: {
    requests: number;
    to_assign_median_min: number | null;
    to_resolve_median_min: number | null;
  };
  timeline: AarTimelineEntry[];
  limitations: string[];
}
