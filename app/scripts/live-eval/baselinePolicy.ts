/**
 * Scripted commander for the evaluation harness (evaluate.ts --policy baseline): reads only the
 * wire observation (what Claude sees) and follows its model decision aids (demo/decisionAids.ts,
 * observation.decision_aids), no LLM. It shows what the aids alone achieve, so a Claude run can be
 * compared with it, and checks whether a scenario is winnable at all.
 *
 * Rules, every call:
 * - Evacuation: each schedule entry with action order_now is ordered out now, schedule / reschedule
 *   with start_minute = recommended_start_minute, to the entry's destination. A zone scheduled
 *   earlier that has left the schedule (no free-burn threat any more) is cancelled.
 * - Fires: a fire with no strategy, or whose strategy no longer contains (or is no longer offered),
 *   gets the recommended strategy and its units; with a containable strategy kept, the units its
 *   option still asks for are sent. When nothing contains, the all-units package: its strategy,
 *   every free unit that can reach, the available aircraft and the sized resource orders.
 */

import type { DemoObservation, DemoOrder } from "../../src/demo/contracts";

export function baselineOrders(obs: DemoObservation): { orders: DemoOrder[]; summary: string } {
  const orders: DemoOrder[] = [];
  const aids = obs.decision_aids;
  if (!aids) return { orders, summary: "no decision aids in the observation" };
  const zones = new Map(obs.zones.map((z) => [z.id, z]));
  const notes: string[] = [];

  // ---- evacuation ----
  const inPlan = new Set<string>();
  const maxStart = obs.clock.minute + obs.clock.max_schedule_ahead_min;
  for (const p of aids.evacuation) {
    inPlan.add(p.zone_id);
    const zone = zones.get(p.zone_id);
    if (!zone || !p.destination_id || !zone.options.some((o) => o.destination_id === p.destination_id)) continue;
    if (p.action === "order_now" && (zone.order.status === "none" || zone.order.status === "scheduled" || zone.order.status === "lifted")) {
      orders.push({ type: "order_evacuation", zone_id: p.zone_id, destination_id: p.destination_id, start_minute: null, reason: `schedule: order now (eta ${p.eta_min} min, ${p.too_late ? "too late" : "start now"})` });
    } else if ((p.action === "schedule" || p.action === "reschedule") && zone.order.status !== "leaving" && zone.order.status !== "done") {
      const start = Math.min(maxStart, p.recommended_start_minute);
      if (zone.order.status === "scheduled" && zone.order.start_minute === start && zone.order.destination_id === p.destination_id) continue;
      orders.push({ type: "order_evacuation", zone_id: p.zone_id, destination_id: p.destination_id, start_minute: start, reason: `schedule: start at minute ${start} (latest safe ${p.latest_safe_start_minute})` });
    }
  }
  for (const zone of obs.zones) {
    if (zone.order.status === "scheduled" && !inPlan.has(zone.id)) orders.push({ type: "cancel_evacuation", zone_id: zone.id, reason: "no longer in the evacuation schedule" });
  }
  // All clear (demo/allClear.ts): lift each zone the decision aid lists as eligible and no longer in the schedule.
  for (const c of aids.all_clear ?? []) {
    if (!inPlan.has(c.zone_id)) orders.push({ type: "lift_evacuation", zone_id: c.zone_id, reason: `all clear: ${c.basis}` });
  }

  // ---- fires ----
  // Units the last decision's orders were refused for (e.g. no road route from where they stand) are not re-sent at once.
  const refused = new Set(obs.crews.filter((c) => (obs.previous?.rejected ?? []).some((r) => r.includes(`${c.id} `))).map((c) => c.id));
  const sent = new Set<string>();
  const send = (crew: string, fireId: string, positionId: string | null, why: string) => {
    if (sent.has(crew) || refused.has(crew)) return;
    sent.add(crew);
    orders.push({ type: "send_crew", crew_id: crew, fire_id: fireId, position_id: positionId, reason: why });
  };
  for (const aid of aids.strategy) {
    const fire = obs.fires.find((f) => f.id === aid.fire_id);
    if (!fire || fire.status !== "burning") continue;
    const current = fire.strategy;
    const currentOption = current ? fire.strategy_options.find((o) => o.id === current.id) : undefined;
    const currentHolds = current !== null && current.still_offered && aid.options.find((o) => o.id === current.id)?.containable === true;
    if (aid.recommended_strategy_id && !aid.overdue) {
      if (!currentHolds && current?.id !== aid.recommended_strategy_id) {
        orders.push({ type: "set_strategy", fire_id: fire.id, strategy_id: aid.recommended_strategy_id, reason: "decision aid: containable, fewest homes burned" });
        for (const u of aid.recommended_send) send(u.crew_id, fire.id, u.position_id, `for ${aid.recommended_strategy_id}`);
        notes.push(`${fire.id}: ${aid.recommended_strategy_id}`);
      } else if (currentOption) {
        for (const u of currentOption.send) send(u.crew_id, fire.id, currentOption.position_id, `more units for ${currentOption.id}`);
      }
      continue;
    }
    const pkg = aid.all_units;
    if (!pkg) continue;
    // Overdue with a strategy the model still calls containable: keep it and put every unit on it.
    const keep = aid.overdue && currentHolds && currentOption !== undefined;
    const strategyId = keep ? currentOption!.id : pkg.strategy_id;
    const positionId = keep ? currentOption!.position_id : (pkg.send[0]?.position_id ?? null);
    if (current?.id !== strategyId) orders.push({ type: "set_strategy", fire_id: fire.id, strategy_id: strategyId, reason: "decision aid: nothing contains; fewest homes burned with every unit" });
    for (const u of pkg.send) send(u.crew_id, fire.id, positionId, aid.overdue ? "overdue containment: all available units" : "all available units");
    for (const a of pkg.aircraft) send(a.aircraft_id, fire.id, null, "available aircraft");
    for (const o of pkg.order_resources) orders.push({ type: "order_resources", fire_id: fire.id, resource: o.resource, count: o.count, reason: "all available units: sized extended-attack order" });
    notes.push(`${fire.id}: all units on ${strategyId}${aid.overdue ? " (overdue)" : ""}`);
  }
  const evac = orders.filter((o) => o.type === "order_evacuation").length;
  return { orders, summary: `${orders.length} orders (scripted): ${evac} evacuation${notes.length ? `; ${notes.join("; ")}` : ""}` };
}
