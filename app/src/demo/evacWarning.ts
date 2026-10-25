/**
 * Evacuation warnings (warn_evacuation): "be ready to leave" for a zone a fire may threaten later,
 * below an evacuation order. Pure board state: no React, network or LLM.
 *
 * Contract (BoardOrder warn_evacuation, demo/contracts.ts DemoOrder):
 * - `{type: "warn_evacuation", zone_id, destination_id?: string | null, reason}`: the zone's
 *   order status becomes "warning" (model.ts zoneOrderStatus). Nobody leaves: households stay home
 *   (the board has no self-evacuation, and no source on how much a warning shortens departures, so
 *   the departure curve of a later order is unchanged). destination_id is the route residents
 *   should be ready to take (one of the zone's route options); null or absent = the zone's first
 *   route option (the routes endpoint's best).
 * - Allowed on a zone with no order (none), a scheduled order (the schedule is replaced: departures
 *   will not start by themselves), an existing warning (re-warn to change the route) or a lifted
 *   zone (the lift ends as for a new order: model.ts endLiftForNewOrder). Refused on a zone leaving,
 *   done or overrun (an order outranks a warning).
 * - order_evacuation on a warned zone supersedes the warning (now or scheduled).
 * - cancel_evacuation on a warned zone withdraws the warning (back to none).
 * - On the live drill the warning is published to the zone's phones as `be_ready` with the route
 *   and no start time (app/backend/api/live/board_guidance.py, reason_code board_warning).
 */

import { endLiftForNewOrder } from "./allClear";
import { logEvent, zoneOrderStatus, type Board, type RouteOption, type ZoneState } from "./model";

/** A zone's evacuation warning (ZoneState.warning). */
export interface ZoneWarning {
  /** Board minute the warning was issued (or last re-issued). */
  at: number;
  actor: "agent" | "you";
  reason: string;
  /** The route residents should be ready to take (a route option of the zone); null when the zone has none. */
  route: RouteOption | null;
}

/** warn_evacuation: returns why it is refused, or null when applied (see the module comment). */
export function warnEvacuation(
  board: Board,
  zone: ZoneState,
  destinationId: string | null,
  routes: ReadonlyMap<string, RouteOption[]>,
  actor: "agent" | "you",
  reason = "",
): string | null {
  const status = zoneOrderStatus(zone, board.minute);
  if (status === "leaving" || status === "done") return `${zone.name} is already ordered out (an order outranks a warning; lift_evacuation once all clear).`;
  if (status === "overrun") return `${zone.name} is already overrun.`;
  const options = routes.get(zone.id) ?? [];
  const route = destinationId === null ? (options[0] ?? null) : (options.find((o) => o.destination_id === destinationId) ?? null);
  if (destinationId !== null && !route) return `No route from ${zone.name} to ${destinationId}.`;
  if (zone.warning && zone.warning.route?.destination_id === route?.destination_id && !zone.pendingOrder && !zone.lift) {
    return `${zone.name} is already warned${route ? ` (be ready to leave toward ${route.name})` : ""}.`;
  }
  if (zone.lift) endLiftForNewOrder(board, zone);
  const pending = zone.pendingOrder;
  zone.pendingOrder = null;
  const was = zone.warning;
  zone.warning = { at: board.minute, actor, reason, route };
  const replaced = pending ? ` (replaces the evacuation scheduled at minute ${pending.startMinute})` : "";
  logEvent(
    board,
    "order",
    actor,
    `Evacuation warning: ${zone.name}, be ready to leave${route ? ` toward ${route.name}` : ""}${replaced}${was ? " (route changed)" : ""}.`,
    {
      action: "evacuation_warned",
      zoneId: zone.id,
      households: zone.households,
      people: zone.occupants,
      ...(route ? { destinationId: route.destination_id, etaMin: route.eta_min } : {}),
    },
  );
  return null;
}

/** cancel_evacuation on a warned zone (no schedule): withdraws the warning. Returns why not, or null. */
export function withdrawWarning(board: Board, zone: ZoneState, actor: "agent" | "you"): string | null {
  if (!zone.warning) return `${zone.name} has no evacuation warning.`;
  const w = zone.warning;
  zone.warning = null;
  logEvent(board, "order", actor, `Evacuation warning withdrawn: ${zone.name} (no order; residents need not be ready to leave).`, {
    action: "evacuation_warning_withdrawn",
    zoneId: zone.id,
    households: zone.households,
    people: zone.occupants,
    ...(w.route ? { destinationId: w.route.destination_id } : {}),
  });
  return null;
}
