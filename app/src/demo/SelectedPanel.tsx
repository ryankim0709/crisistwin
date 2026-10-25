import { Button, Facts, IconButton, Notice, ProgressBar, Tag } from "../ui";
import { containmentPct } from "./observation";
import { FIRE_STATUS, SOURCE_LABEL, TEAM_STATUS, nf, simClock } from "./format";
import {
  DEPARTURE_SPREAD_MINUTES,
  attackPositions,
  positionEta,
  positionOptions,
  nearestFree,
  currentContainment,
  fireAreaHa,
  firePerimeterM,
  perimeterGrowth,
  positionDestKey,
  unitLineOn,
  unreachableClasses,
  zoneCounts,
  evacuationEstimate,
  trafficPicture,
  vehiclesPerHousehold,
  zoneOrderStatus,
  type Board,
  type Fire,
  type EvacuationEstimate,
  type RouteOption,
  type ZoneForecast,
} from "./model";
import type { Selection } from "./DemoMap";
import { ALL_CLEAR_HOLD_MINUTES, ALL_CLEAR_WINDOW_MINUTES, allClearCheck } from "./allClear";
import { zoneSnapshotItems } from "../live/ScenarioResources";
import type { ScenarioSnapshot } from "../live/scenarioSnapshot";
import {
  fireResponse,
  fireTimeline,
  initialAttackRecommendation,
  notReportedText,
  reachText,
  reportText,
  resourceCountsText,
  unitAccessText,
  wallClock,
} from "./boardResponse";
import { TACTIC_LABEL } from "../response/containment";
import { fireStateAreas } from "./fireState";
import { unitsWorking } from "./suppression";
import { computeStrategyOptions, predictionText, unitsNeededText, type StrategyOption } from "./strategyOptions";
import { runCard } from "../response/runCards";
import { ORDER_COMPLIANCE, holdsFlameFeet, kindLabel } from "./realism";

const SAFETY: Record<RouteOption["safety"], string> = {
  clear: "clear of fire",
  passes_near_fire: "passes near fire",
  passes_fire: "passes through fire",
};

export interface PanelActions {
  closeFire: (fireId: string) => void;
  /** positionId: one of the fire's attack positions (line ahead of it), or omitted for direct attack. */
  sendTeam: (teamId: string, fireId: string, positionId?: string) => void;
  releaseTeam: (teamId: string) => void;
  /** Orders the zone out now (replaces a scheduled order), or redirects a zone already leaving. */
  orderZone: (zoneId: string, destinationId: string) => void;
  /** Cancels the zone's scheduled (not yet started) evacuation order. */
  cancelZoneOrder: (zoneId: string) => void;
  /** Lifts the zone's evacuation order (all clear; refused unless demo/allClear.ts allows it). */
  liftZoneOrder: (zoneId: string) => void;
}

const eta = (m: number | null) => (m === null ? "Not forecast" : m === 0 ? "There now" : `${m} min`);

const POSITION_NAME: Record<string, string> = {
  head: "Head",
  flank_left: "Left flank",
  flank_right: "Right flank",
  zone: "Zone edge",
};

/** The fire's attack positions from the solver's forecast, each with the nearest free unit to send. */
function AttackPositions({ board, fire, actions }: { board: Board; fire: Fire; actions: PanelActions }) {
  const positions = attackPositions(board, fire);
  if (positions.length === 0) return null;
  return (
    <>
      <p className="dm-subhead">Line ahead of the fire (forecast)</p>
      <ul className="dm-mini-list">
        {positions.map((p) => {
          const fireEta = positionEta(board, p);
          // Nearest free unit that can reach the anchor by road (units whose class has no road route there are left out).
          const next = positionOptions(board, fire, p, 1)[0];
          const blocked = unreachableClasses(board, positionDestKey(fire, p), p.point);
          const crew = p.line ? board.teams.filter((t) => t.lineId === p.line!.id).map((t) => t.id) : [];
          const where = p.kind === "head" ? `${POSITION_NAME.head} +${p.id.slice(5)} min` : p.kind === "zone" ? `${POSITION_NAME.zone} ${p.protectsZoneIds[0] ?? ""}` : POSITION_NAME[p.kind];
          return (
            <li key={p.id}>
              <span>
                <strong>{where}</strong>: fire {fireEta === null ? "not forecast" : fireEta === 0 ? "there now" : `in ${Math.round(fireEta)} min`},{" "}
                {nf(p.aM + p.bM)} m line{p.line ? ` (${nf(p.line.builtM)} m built${crew.length ? `, ${crew.join(" ")}` : ""})` : ""}, flame{" "}
                {p.flameFt.toFixed(1)} ft{p.crowning ? ", crown fire" : ""}
                {blocked.length ? `; no road route for ${blocked.map((b) => b.kinds.map(kindLabel).join(", ")).join(", ")}` : ""}
              </span>
              {next ? (
                <Button size="sm" variant="ghost" disabled={fireEta === 0} onClick={() => actions.sendTeam(next.teams[0], fire.id, p.id)}>
                  Send {next.teams[0]} ({next.route === "estimate" ? "about " : ""}
                  {Math.ceil(next.arriveMin)} min)
                </Button>
              ) : (
                <span className="lc-dim">{board.teams.some((t) => t.status === "available") ? "No free unit can reach it" : "No free unit"}</span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="dm-note">
        Read from the fire model's forecast: where the head will be in 30 and 60 min, the flanks, and where the fire first reaches a
        zone. A unit builds the line across the fire's path there; built line is a barrier in the fire model, which re-solves as it
        grows, and a fire the model shows held by its line is contained.
      </p>
    </>
  );
}

const OUTCOME: Record<StrategyOption["outcome"], { label: string; tone: "success" | "danger" | "info" }> = {
  contained: { label: "Contains", tone: "success" },
  not_containable: { label: "Not containable", tone: "danger" },
  line_ahead: { label: "Line ahead", tone: "info" },
};

/**
 * The fire's containment strategies with the model's consequences (strategyOptions.ts), and the
 * one chosen. Claude chooses with set_strategy; this table only shows the options.
 */
function StrategyTable({ board, fire }: { board: Board; fire: Fire }) {
  const options = computeStrategyOptions(board, fire);
  if (options.length === 0) return null;
  const chosen = fireResponse(board, fire)?.strategy?.id ?? null;
  return (
    <>
      <p className="dm-subhead">Containment strategies (model forecast; Claude chooses)</p>
      <div className="ui-table-scroll">
        <table className="ui-table">
          <thead>
            <tr>
              <th scope="col">Strategy</th>
              <th scope="col">Outcome</th>
              <th scope="col">Units</th>
              <th scope="col" className="num">Burned ha</th>
              <th scope="col">Zones reached</th>
            </tr>
          </thead>
          <tbody>
            {options.map((o) => (
              <tr key={o.id} aria-current={o.id === chosen ? "true" : undefined}>
                <th scope="row">
                  {o.name}
                  {o.id === chosen ? (
                    <>
                      {" "}
                      <Tag tone="info">Chosen</Tag>
                    </>
                  ) : null}
                  {o.safety.length ? <span className="lc-dim"><br />{o.safety[0]}</span> : null}
                </th>
                <td>
                  <Tag tone={OUTCOME[o.outcome].tone}>{OUTCOME[o.outcome].label}</Tag>
                  <span className="lc-dim"><br />{predictionText(o)}</span>
                </td>
                <td>
                  {unitsNeededText(o.unitsNeeded)}
                  {o.send.length ? (
                    <span className="lc-dim">
                      <br />
                      send {o.send.map((s) => `${s.team.id} ${s.road ? "" : "~"}${Math.ceil(s.etaMin)} min`).join(", ")}
                    </span>
                  ) : null}
                </td>
                <td className="num">{o.burnedHa === null ? "–" : o.burnedHa.toFixed(1)}</td>
                <td>{o.zonesReached.length ? o.zonesReached.join(", ") : "none"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="dm-note">
        Simulated. Containment minutes come from the line race with each tactic (Hauling-chart holding limits, reachable
        edge); burned area is the fire model's free-burn forecast at containment (or at +2 h when not contained, or when
        the fire reaches a line), an upper bound. A ~ marks a straight-line travel estimate.
      </p>
    </>
  );
}

const DISPATCH_LEVEL: Record<string, string> ={ low: "Low", medium: "Medium", high: "High" };
const IA_STATE: Record<string, string> = { in_progress: "In progress", contained: "Caught", failed: "Failed, extended attack" };
const TIER_LABEL: Record<string, string> = { closest: "Closest resource", mutual_aid: "Mutual aid", state: "State resource" };

/**
 * The response model on this fire (boardResponse.ts): dispatch level and the recommended run card
 * (a recommendation: nothing is sent unless the AI agent or you order it), tactic, initial attack, aircraft.
 */
function responseFacts(board: Board, fire: Fire): { label: string; value: string }[] {
  const fr = fireResponse(board, fire);
  if (!fr) return [];
  const air = board.response.aircraft.filter((a) => a.fireId === fire.id);
  const orders = board.response.orders.filter((o) => o.fireId === fire.id && o.status === "pending");
  const rec = initialAttackRecommendation(board, fire);
  const recText = rec
    ? [
        ...rec.units.map((u) => `${u.team.id} ${Math.round(u.etaMin)} min`),
        ...rec.aircraft.map((a) => `${a.aircraft.id} ${Math.round(a.overFireMin)} min`),
      ].join(", ") + (resourceCountsText(rec.unfilled) !== "none" ? `; to order: ${resourceCountsText(rec.unfilled)}` : "")
    : "";
  return [
    { label: "Dispatch level", value: `${DISPATCH_LEVEL[fr.level] ?? fr.level}, run card ${resourceCountsText(runCard(fr.level, fr.structure))}` },
    ...(rec && resourceCountsText(rec.stillNeeded) !== "none"
      ? [{ label: "Recommended", value: recText || `nothing free to send; to order: ${resourceCountsText(rec.unfilled)}` }]
      : []),
    {
      label: "Strategy",
      value: fr.strategy
        ? `${fr.strategy.name} (${fr.strategy.by === "agent" ? "Claude" : fr.strategy.by === "you" ? "you" : fr.strategy.by}, ${simClock(fr.strategy.at)}; model then: ${fr.strategy.predictionText})`
        : "None chosen yet (units sent without one work direct attack)",
    },
    { label: "Tactic worked", value: TACTIC_LABEL[fr.tactic] },
    { label: "Initial attack", value: IA_STATE[fr.ia] ?? fr.ia },
    ...(air.length
      ? [{ label: "Aircraft", value: air.map((a) => `${a.id} (${a.status.replace(/_/g, " ")}, ${a.drops} drops)`).join(", ") }]
      : []),
    ...(orders.length
      ? [{ label: "On order", value: orders.map((o) => `${o.resource.replace(/_/g, " ")} (${o.tier.replace(/_/g, " ")}, ready ${wallClock(board, o.readyAt)})`).join(", ") }]
      : []),
  ];
}

function FireDetail({ board, id, actions }: { board: Board; id: string; actions: PanelActions }) {
  const fire = board.fires.find((f) => f.id === id);
  if (!fire) return <p className="lc-dim">This fire has left the board.</p>;
  const perimeter = firePerimeterM(fire);
  const teams = board.teams.filter((t) => t.fireId === fire.id);
  const holds = Math.max(0, ...teams.filter((t) => t.status === "on_scene").map((t) => holdsFlameFeet(t.kind)));
  const containIn = currentContainment(board, fire);
  // Report rule (boardResponse.ts): a fire dispatch does not have yet offers no action (the board refuses them too).
  const notReported = notReportedText(board, fire);
  // Nearest free unit that can reach the fire by road.
  const nearest = fire.status === "burning" && !notReported ? nearestFree(board, fire)[0] : undefined;
  const nextTeam = nearest?.team;
  return (
    <>
      <div className="dm-tags">
        <Tag tone={FIRE_STATUS[fire.status].tone}>{FIRE_STATUS[fire.status].label}</Tag>
        <Tag>{SOURCE_LABEL[fire.source]}</Tag>
      </div>
      <p className="dm-note">
        {fireTimeline(board, fire)}
        {reportText(board, fire) ? <><br />{reportText(board, fire)}</> : null}
      </p>
      <p className="dm-subhead">{fire.status === "out" ? "Resolved" : `${containmentPct(fire)}% contained`}</p>
      <ProgressBar value={containmentPct(fire) / 100} label={`${fire.id}: ${containmentPct(fire)}% contained`} />
      <Facts
        items={[
          { label: "Started", value: simClock(fire.ignitedAt) },
          { label: "Studio run", value: `${fire.studio.tag} '${fire.studio.name}', ignition ${fire.studio.ignition}` },
          { label: "Area", value: `${fireAreaHa(fire).toFixed(1)} ha` },
          { label: "Head spread", value: `${fire.headRate} m/min toward ${Math.round(fire.rates.headingDegrees)}°` },
          { label: "Head flame", value: `${fire.rates.headFlameFeet.toFixed(1)} ft${fire.rates.crowning ? ", crown fire" : ""}` },
          { label: "Length to breadth", value: fire.rates.lengthToBreadth.toFixed(1) },
          { label: "Slope at head", value: `${Math.round(fire.rates.slopePercent)}%` },
          {
            label: "Perimeter",
            value: `${nf(perimeter)} m${fire.status === "burning" ? `, +${nf(perimeterGrowth(fire))} m/min` : ""}`,
          },
          {
            label: "Line built",
            value: `${nf(Math.min(fire.lineM, perimeter))} m (${Math.min(100, Math.round((fire.lineM / Math.max(1, perimeter)) * 100))}%)`,
          },
          {
            // Simulated cell states (demo/fireState.ts) and the units that put edge out this minute (demo/suppression.ts).
            label: "Burning now",
            value: `${fireStateAreas(board, fire).burningHa.toFixed(1)} ha (put out ${fireStateAreas(board, fire).extinguishedHa.toFixed(1)} ha; ${unitsWorking(board, fire.id).length} units working the edge)`,
          },
          {
            label: "Contained in",
            value:
              fire.status !== "burning"
                ? "Done"
                : teams.length === 0
                  ? "No units assigned"
                  : containIn === null
                    ? "Fire is outrunning its units"
                    : `about ${containIn} min`,
          },
        ]}
      />
      {fire.status !== "out" && responseFacts(board, fire).length ? (
        <>
          <p className="dm-subhead">Response (simulated; units go only when ordered)</p>
          <Facts items={responseFacts(board, fire)} />
        </>
      ) : null}
      {teams.length ? (
        <ul className="dm-mini-list">
          {teams.map((t) => (
            <li key={t.id}>
              <span>
                <strong>{t.id}</strong> {kindLabel(t.kind)}, {TEAM_STATUS[t.status].toLowerCase()}
                {t.lineId ? `, line at ${board.lines.find((l) => l.id === t.lineId)?.plan.id ?? "a position"}` : ""}
                {t.travel === "pending" ? ", waiting for its road route" : ""}
                {t.status === "en_route" && t.arriveAt !== null ? `, ${Math.ceil(t.arriveAt - board.minute)} min` : ""}
                {t.status === "on_scene" && t.workMode !== null ? <span className="lc-dim"> {unitAccessText(board, t)}</span> : null}
              </span>
              <Button size="sm" variant="ghost" onClick={() => actions.releaseTeam(t.id)}>
                Release
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {notReported ? <Notice tone="warning">{notReported}</Notice> : null}
      <div className="dm-actions" hidden={!!notReported}>
        {fire.status === "burning" && !notReported ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={!nextTeam}
            onClick={() => nextTeam && actions.sendTeam(nextTeam.id, fire.id)}
          >
            {nearest
              ? `Send ${nearest.team.id} (${nearest.road ? "" : "about "}${Math.ceil(nearest.eta)} min away)`
              : board.teams.some((t) => t.status === "available")
                ? "No free unit can reach it"
                : "No free unit"}
          </Button>
        ) : null}
        {fire.status !== "out" && !notReported ? (
          <Button size="sm" variant="danger" onClick={() => actions.closeFire(fire.id)}>
            Close out fire
          </Button>
        ) : null}
      </div>
      {fire.status === "burning" && !notReported ? <StrategyTable board={board} fire={fire} /> : null}
      {fire.status === "burning" && !notReported ? <AttackPositions board={board} fire={fire} actions={actions} /> : null}
      {fire.reportIds.length ? (
        <p className="dm-note">
          {fire.reportIds.length === 1 ? "A field report" : `${fire.reportIds.length} field reports`} joined this fire. Closing the
          fire out resolves {fire.reportIds.length === 1 ? "it" : "them"} on Live command.
        </p>
      ) : null}
      {reachText(board, fire) ? <Notice tone="warning">{reachText(board, fire)}</Notice> : null}
      <p className="dm-note">
        Spread from the simulator's cell solver (as /fire and Simulation Studio); head figures are its Rothermel values at the
        fire's leading front cell{fire.noSpread ? `. This fire cannot spread: ${fire.noSpread}` : ""}. Units build line at their sourced rate for this
        fuel once they reach the edge from where their road ends (hose within reach, otherwise on foot); the fire is contained
        when the line reaches its perimeter (the footprint's edge facing unburned fuel) and the head flame is within what their
        line holds{holds > 0 ? ` (${holds} ft now)` : ""}{fire.rates.crowning ? "; the head is crowning, so no line holds it" : ""}. Simulated.
      </p>
    </>
  );
}

function ZoneDetail({
  board,
  id,
  forecast,
  options,
  actions,
  snapshot,
}: {
  board: Board;
  id: string;
  forecast: ZoneForecast | undefined;
  options: RouteOption[];
  actions: PanelActions;
  snapshot?: ScenarioSnapshot | null;
}) {
  const zone = board.zones.find((z) => z.id === id);
  if (!zone) return null;
  const c = zoneCounts(zone, board.minute);
  const pending = zone.pendingOrder;
  const orderStatus = zoneOrderStatus(zone, board.minute);
  const lift = orderStatus === "lifted" ? zone.lift : null;
  // demo/allClear.ts: whether the order can be lifted now (only for a zone with one to lift).
  const clear = orderStatus === "leaving" || orderStatus === "done" || orderStatus === "overrun" ? allClearCheck(board, zone) : null;
  const ordered = zone.orderedAt !== null && !lift;
  const status = lift
    ? `All clear since ${simClock(lift.at)}`
    : zone.overrunAt !== null
      ? "Overrun"
      : zone.orderedAt !== null
        ? "Evacuating"
        : pending
          ? `Scheduled ${simClock(pending.startMinute)}`
          : orderStatus === "warning"
            ? "Be ready (warning)"
            : "No order";
  // Simulated traffic (model.ts evacuationEstimate): congested time, bottleneck and margin per option.
  const picture = trafficPicture(board);
  const estimates = new Map<string, EvacuationEstimate>(
    options.map((o) => [o.destination_id, evacuationEstimate(board, picture, zone, o, forecast?.coreEta ?? null)]),
  );
  const current = zone.route ? estimates.get(zone.route.destination_id) : undefined;
  const margin = (e: EvacuationEstimate) =>
    e.marginMin === null ? "margin n/a" : e.marginMin < 0 ? `${-Math.round(e.marginMin)} min short` : `${Math.round(e.marginMin)} min margin`;
  const via = (e: EvacuationEstimate) =>
    e.bottleneck ? `bottleneck ${e.bottleneck.segment.name} (${nf(e.bottleneck.segment.capacity_veh_h)} veh/h, ${Math.round(e.clearanceMin)} min to clear)` : "";
  const snapshotRows = zoneSnapshotItems(snapshot?.zones.find((z) => z.zone_id === id), snapshot);
  const slack = forecast?.coreEta != null ? forecast.coreEta - DEPARTURE_SPREAD_MINUTES : null;
  return (
    <>
      <div className="dm-tags">
        <Tag tone={lift ? "neutral" : zone.overrunAt !== null ? "danger" : zone.orderedAt !== null || pending ? "warning" : "neutral"}>{status}</Tag>
        {forecast?.edgeEta != null && zone.overrunAt === null && !lift ? <Tag tone="warning">At risk</Tag> : null}
      </div>
      {snapshotRows.length ? (
        <>
          <p className="dm-note dm-snap-note">Resource snapshot for this zone (planning simulation):</p>
          <Facts items={snapshotRows} />
        </>
      ) : null}
      <Facts
        items={[
          { label: "Households", value: nf(zone.households) },
          { label: "Vehicles (sim)", value: `${nf(zone.vehicles)}, ${nf(Math.round(c.enRoute * vehiclesPerHousehold(zone)))} on the road` },
          { label: "At home", value: nf(c.home) },
          { label: "On the road", value: nf(c.enRoute) },
          { label: "Out", value: nf(c.out) },
          ...(lift || c.returning > 0
            ? [{ label: "Returning home (sim)", value: `${nf(c.returning)}${lift && lift.returnMinutes > 0 ? `, about ${Math.round(lift.returnMinutes)} min free-flow drive back` : ""}` }]
            : []),
          { label: "Caught by fire", value: nf(c.caught) },
          zone.carlessGivenCar > 0
            ? { label: "No vehicle (data)", value: `${nf(zone.carlessGivenCar)} households, given one car each (assumption: every household drives)` }
            : { label: "No vehicle", value: `${nf(zone.noVehicle)} households, need transport` },
          { label: "Fire at edge", value: eta(forecast?.edgeEta ?? null) },
          { label: "Fire at core", value: eta(forecast?.coreEta ?? null) },
          ...(slack !== null && !ordered
            ? [{ label: "Time left to order", value: slack < 0 ? `${-slack} min late` : `${slack} min` }]
            : []),
          ...(pending && zone.orderedAt === null
            ? [
                {
                  label: "Scheduled order",
                  value: `${pending.route.name}, households leave from ${simClock(pending.startMinute)} (in ${Math.max(0, Math.ceil(pending.startMinute - board.minute))} min; ${pending.actor === "agent" ? "Claude" : "you"} scheduled it)`,
                },
              ]
            : []),
          ...(zone.route && !lift
            ? [
                {
                  label: "Route (sim traffic)",
                  value: current
                    ? `${zone.route.name}, ${Math.round(current.congestedEtaMin)} min in traffic (${Math.round(current.freeFlowMin)} free-flow), ${margin(current)}`
                    : `${zone.route.name}, ${zone.route.eta_min} min free-flow`,
                },
                ...(current?.bottleneck ? [{ label: "Bottleneck", value: via(current) }] : []),
              ]
            : []),
        ]}
      />
      {zone.overrunAt === null ? (
        options.length ? (
          <div className="dm-options" role="group" aria-label="Evacuation routes">
            {options.map((o) => (
              <Button
                key={o.destination_id}
                size="sm"
                variant={ordered && zone.route?.destination_id === o.destination_id ? "soft" : "secondary"}
                disabled={ordered && zone.route?.destination_id === o.destination_id}
                onClick={() => actions.orderZone(zone.id, o.destination_id)}
              >
                {!ordered ? (pending ? "Evacuate now via" : lift ? "Evacuate again via" : "Evacuate via") : "Redirect to"} {o.name} ·{" "}
                {(() => {
                  const e = estimates.get(o.destination_id);
                  return e
                    ? `${Math.round(e.congestedEtaMin)} min in traffic (${Math.round(e.freeFlowMin)} free) · ${margin(e)}${e.bottleneck ? ` · via ${e.bottleneck.segment.name}` : ""}`
                    : `${o.eta_min} min`;
                })()}{" "}
                · {SAFETY[o.safety]}
              </Button>
            ))}
          </div>
        ) : (
          <Notice compact>No route options yet.</Notice>
        )
      ) : null}
      {pending && zone.orderedAt === null && zone.overrunAt === null ? (
        <div className="dm-options">
          <Button size="sm" variant="secondary" onClick={() => actions.cancelZoneOrder(zone.id)}>
            Cancel scheduled evacuation ({simClock(pending.startMinute)})
          </Button>
        </div>
      ) : null}
      {orderStatus === "warning" ? (
        <div className="dm-options">
          <Button size="sm" variant="secondary" onClick={() => actions.cancelZoneOrder(zone.id)}>
            Withdraw evacuation warning
          </Button>
        </div>
      ) : null}
      {clear ? (
        <div className="dm-options">
          <Button size="sm" variant="secondary" disabled={!clear.eligible} onClick={() => actions.liftZoneOrder(zone.id)}>
            Lift evacuation order (all clear)
          </Button>
          {clear.eligible ? null : (
            <p className="dm-note">
              Not yet (fire model, simulated): {clear.reasons.join("; ")}.
            </p>
          )}
        </div>
      ) : null}
      {lift ? (
        <Notice compact>
          Order lifted at {simClock(lift.at)} by {lift.actor === "agent" ? "Claude" : "you"}: households that stayed are home;{" "}
          {c.returning > 0 || c.enRoute > 0 ? `${nf(c.returning + c.enRoute)} still on their way back.` : "everyone who left is back."}
        </Notice>
      ) : null}
      <p className="dm-note">
        After an order {Math.round(ORDER_COMPLIANCE * 100)}% of households with a vehicle leave, after{" "}
        {DEPARTURE_SPREAD_MINUTES} min on average from the order's start (now, or the minute it was scheduled
        for); with no order nobody leaves (this board has no self-evacuation). Households without a vehicle stay. Those still home when fire reaches the zone core are caught.
        An order can be lifted (all clear) once every reported fire that came within {ALL_CLEAR_WINDOW_MINUTES} min of the zone has been
        contained or out for {ALL_CLEAR_HOLD_MINUTES} min and none is forecast to reach it within {ALL_CLEAR_WINDOW_MINUTES} min (board
        rules, assumptions); residents then drive back at the route's free-flow time.
        Travel times are simulated traffic: zones sharing a road slow each other (BPR volume-delay on assumed road
        capacities); margin = fire at core − ({DEPARTURE_SPREAD_MINUTES} min departure + bottleneck clearance + time in
        traffic).
      </p>
    </>
  );
}

function TeamDetail({ board, id, actions }: { board: Board; id: string; actions: PanelActions }) {
  const team = board.teams.find((t) => t.id === id);
  if (!team) return null;
  const station = board.stations.find((s) => s.id === team.station);
  const fire = team.fireId ? (board.fires.find((f) => f.id === team.fireId) ?? null) : null;
  return (
    <>
      <Facts
        items={[
          { label: "Status", value: TEAM_STATUS[team.status] },
          { label: "Fire", value: team.fireId ?? "None" },
          { label: "Type", value: kindLabel(team.kind) },
          { label: "Home base", value: station ? (station.label ?? `${station.name}${station.type === "synthetic" ? " (synthetic)" : ""}`) : "None" },
          { label: "Department", value: `${board.response.departments.find((d) => d.id === team.department)?.name ?? team.department} (${TIER_LABEL[team.tier] ?? team.tier})` },
          ...(team.coverStation
            ? [{ label: "Covering", value: board.stations.find((s) => s.id === team.coverStation)?.name ?? team.coverStation }]
            : []),
          ...(team.waterGallons !== null ? [{ label: "Water on board", value: `${nf(team.waterGallons)} gal` }] : []),
          ...((team.status === "resting" || team.status === "refilling") && team.restUntil !== null
            ? [{ label: team.status === "resting" ? "Rested at" : "Refilled at", value: wallClock(board, team.restUntil) }]
            : []),
          ...(team.status === "out_of_service" && team.outOfServiceUntil !== null
            ? [{ label: "Back in service", value: wallClock(board, team.outOfServiceUntil) }]
            : []),
          { label: "Line", value: `${unitLineOn(board, team, fire).toFixed(1)} m/min here` },
          { label: "Holds flames up to", value: `${holdsFlameFeet(team.kind)} ft` },
          ...(team.status === "en_route" || team.status === "returning" || team.status === "moving_up"
            ? [
                {
                  label: "Travel",
                  value:
                    team.travel === "pending"
                      ? team.status === "returning"
                        ? "Waiting where it is for its road route home"
                        : team.status === "moving_up"
                          ? "Waiting where it is for its road route to the station it covers"
                          : "Waiting for its road route"
                      : team.travel === "road_offboard"
                        ? "Road network, with an off-road leg"
                        : team.travel === "straight_line"
                          ? "Time estimated from straight-line distance (no road route)"
                          : "Road network",
                },
              ]
            : []),
          ...(team.status === "returning" || team.status === "moving_up"
            ? [
                {
                  label: team.status === "moving_up" ? "At the covered station" : "Back at station",
                  value:
                    team.travel === "pending" || team.arriveAt === null
                      ? "Not known yet (no road route yet)"
                      : `in ${Math.max(0, Math.ceil(team.arriveAt - board.minute))} min`,
                },
              ]
            : []),
        ]}
      />
      {team.status === "en_route" || team.status === "on_scene" || team.status === "refilling" ? (
        <div className="dm-actions">
          <Button size="sm" variant="secondary" onClick={() => actions.releaseTeam(team.id)}>
            Release {team.id}
          </Button>
        </div>
      ) : null}
    </>
  );
}

export default function SelectedPanel({
  board,
  selection,
  forecasts,
  routes,
  actions,
  snapshot,
  onClose,
}: {
  board: Board;
  selection: Selection;
  forecasts: Map<string, ZoneForecast>;
  routes: ReadonlyMap<string, RouteOption[]>;
  actions: PanelActions;
  /** Drill resource snapshot, for the zone's household and vehicle figures. */
  snapshot?: ScenarioSnapshot | null;
  onClose: () => void;
}) {
  const title =
    selection.kind === "zone"
      ? (board.zones.find((z) => z.id === selection.id)?.name ?? selection.id)
      : selection.kind === "team"
        ? `Unit ${selection.id}`
        : `Fire ${selection.id}`;
  return (
    <section className="dm-section dm-selected" aria-label="Selected item">
      <div className="dm-section-head">
        <h2>{title}</h2>
        <IconButton label="Clear selection" size="sm" onClick={onClose}>
          ×
        </IconButton>
      </div>
      {selection.kind === "fire" ? <FireDetail board={board} id={selection.id} actions={actions} /> : null}
      {selection.kind === "zone" ? (
        <ZoneDetail
          board={board}
          id={selection.id}
          forecast={forecasts.get(selection.id)}
          options={routes.get(selection.id) ?? []}
          actions={actions}
          snapshot={snapshot}
        />
      ) : null}
      {selection.kind === "team" ? <TeamDetail board={board} id={selection.id} actions={actions} /> : null}
    </section>
  );
}
