/**
 * Runs the AI commander's live drill actions (contracts.ts LiveOrder) through the existing live
 * controller API, as the /live page's controller. demo.py has already checked them against the
 * observation; this re-checks them against the newest command poll, starts the requests and
 * returns a per-order error (null = sent). Request failures arrive later through `onFailure`.
 *
 * Evacuation stays out of here: order_evacuation moves the simulated board only, and phones get
 * guidance only through a proposal a controller approves (docs/adr/0012-controller-guidance.md).
 */

import { LiveError, createTask, helpAction, triageReport } from "../live/api";
import type { CommandResponse } from "../live/types";
import type { LiveOrder } from "./contracts";

const OPEN = new Set(["unverified", "corroborated", "responder_confirmed", "confirmed"]);

export function runLiveOrders(
  token: string | null,
  incidentId: string,
  data: CommandResponse | null,
  orders: LiveOrder[],
  onFailure: (message: string) => void,
): (string | null)[] {
  return orders.map((order) => {
    if (!token || !data || data.incident_id !== incidentId) return "No live drill.";
    const send = (label: string, request: () => Promise<unknown>) => {
      request().catch((error: unknown) =>
        onFailure(`AI commander: ${label} failed: ${error instanceof LiveError ? error.message : "Live API error."}`),
      );
      return null;
    };
    switch (order.type) {
      case "send_rescue": {
        const checkin = data.checkins.need_help.find((h) => h.id === order.help_id);
        if (checkin) {
          if (checkin.help?.task_id) return `${order.help_id} already has a responder task.`;
          return send(`rescue for ${order.help_id}`, () => helpAction(token, checkin.id, "assign", null));
        }
        const report = data.reports.find((r) => r.id === order.help_id && r.kind === "help_needed");
        if (!report || !OPEN.has(report.status)) return `${order.help_id} is not an open help request.`;
        if (report.task_id) return `${order.help_id} already has a task.`;
        return send(`rescue for ${order.help_id}`, () =>
          createTask(token, incidentId, {
            assignee: null,
            kind: "assist",
            target: { coord: report.location.coord },
            report_ids: [report.id],
            note: order.reason.slice(0, 200) || undefined,
          }),
        );
      }
      case "close_road": {
        const reports = data.reports
          .filter((r) => r.kind === "road_blocked" && OPEN.has(r.status) && r.road_ref?.segment_id === order.road_id)
          .sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at));
        const pick = reports.find((r) => r.status !== "confirmed") ?? reports[0];
        if (!pick) return `No open road_blocked report on ${order.road_id}.`;
        if (pick.status === "confirmed") return `${order.road_id} is already confirmed blocked.`;
        return send(`closing ${order.road_id}`, () => triageReport(token, pick.id, "confirm"));
      }
      case "reopen_road": {
        const state = data.road_state.find((s) => s.segment_id === order.road_id);
        if (!state || state.status !== "blocked") return `${order.road_id} is not blocked.`;
        const ids = state.report_ids.filter((id) => {
          const r = data.reports.find((x) => x.id === id);
          return r && r.kind === "road_blocked" && OPEN.has(r.status);
        });
        if (ids.length === 0) return `No open road_blocked report on ${order.road_id} to resolve.`;
        return send(`reopening ${order.road_id}`, () => Promise.all(ids.map((id) => triageReport(token, id, "resolve"))));
      }
      case "confirm_report":
      case "dismiss_report": {
        const report = data.reports.find((r) => r.id === order.report_id);
        if (!report || !OPEN.has(report.status)) return `${order.report_id} is not an open report.`;
        const action = order.type === "confirm_report" ? "confirm" : "dismiss";
        return send(`${action} ${order.report_id}`, () => triageReport(token, report.id, action));
      }
    }
  });
}
