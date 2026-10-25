import { Button, Facts, IconButton, Notice, Tag } from "../ui";
import { FIRE_STATUS, SOURCE_LABEL, TEAM_STATUS, nf, simClock } from "./format";
import {
  DEPARTURE_SPREAD_MINUTES,
  containOptions,
  currentContainment,
  fireAreaHa,
  firePerimeterM,
  perimeterGrowth,
  travelMinutes,
  unitLineOn,
  zoneCounts,
  type Board,
  type RouteOption,
  type ZoneForecast,
} from "./model";
import type { Selection } from "./DemoMap";
import { ORDER_COMPLIANCE, SHADOW_SHARE, holdsFlameFeet, kindLabel } from "./realism";

const SAFETY: Record<RouteOption["safety"], string> = {
  clear: "clear of fire",
  passes_near_fire: "passes near fire",
  passes_fire: "passes through fire",
};

export interface PanelActions {
  closeFire: (fireId: string) => void;
  sendTeam: (teamId: string, fireId: string) => void;
  releaseTeam: (teamId: string) => void;
  orderZone: (zoneId: string, destinationId: string) => void;
}

const eta = (m: number | null) => (m === null ? "Not forecast" : m === 0 ? "There now" : `${m} min`);

function FireDetail({ board, id, actions }: { board: Board; id: string; actions: PanelActions }) {
  const fire = board.fires.find((f) => f.id === id);
  if (!fire) return <p className="lc-dim">This fire has left the board.</p>;
  const perimeter = firePerimeterM(fire);
  const teams = board.teams.filter((t) => t.fireId === fire.id);
  const holds = Math.max(0, ...teams.filter((t) => t.status === "on_scene").map((t) => holdsFlameFeet(t.kind)));
  const containIn = currentContainment(board, fire);
  const next = containOptions(board, fire, 1)[0];
  const nextTeam = next ? board.teams.find((t) => t.id === next.teams[0]) : undefined;
  return (
    <>
      <div className="dm-tags">
        <Tag tone={FIRE_STATUS[fire.status].tone}>{FIRE_STATUS[fire.status].label}</Tag>
        <Tag>{SOURCE_LABEL[fire.source]}</Tag>
      </div>
      <Facts
        items={[
          { label: "Started", value: simClock(fire.ignitedAt) },
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
      {teams.length ? (
        <ul className="dm-mini-list">
          {teams.map((t) => (
            <li key={t.id}>
              <span>
                <strong>{t.id}</strong> {kindLabel(t.kind)}, {TEAM_STATUS[t.status].toLowerCase()}
                {t.status === "en_route" && t.arriveAt !== null ? `, ${Math.ceil(t.arriveAt - board.minute)} min` : ""}
              </span>
              <Button size="sm" variant="ghost" onClick={() => actions.releaseTeam(t.id)}>
                Release
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="dm-actions">
        {fire.status === "burning" ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={!nextTeam}
            onClick={() => nextTeam && actions.sendTeam(nextTeam.id, fire.id)}
          >
            {nextTeam
              ? `Send ${nextTeam.id} (${Math.ceil(travelMinutes(board, nextTeam, fire))} min away)`
              : "No free unit"}
          </Button>
        ) : null}
        {fire.status !== "out" ? (
          <Button size="sm" variant="danger" onClick={() => actions.closeFire(fire.id)}>
            Close out fire
          </Button>
        ) : null}
      </div>
      {fire.reportIds.length ? (
        <p className="dm-note">
          From {fire.reportIds.length === 1 ? "a field report" : `${fire.reportIds.length} field reports`}. Closing the
          fire out resolves {fire.reportIds.length === 1 ? "it" : "them"} on Live command.
        </p>
      ) : null}
      <p className="dm-note">
        Spread from the simulator's cell solver (as /fire and Simulation Studio); head figures are its Rothermel values at the
        fire's leading front cell{fire.noSpread ? `. This fire cannot spread: ${fire.noSpread}` : ""}. Units build line at their sourced rate for this
        fuel; the fire is contained when the line reaches its perimeter (the footprint's edge facing unburned fuel) and the head
        flame is within what their line holds{holds > 0 ? ` (${holds} ft now)` : ""}{fire.rates.crowning ? "; the head is crowning, so no line holds it" : ""}.
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
}: {
  board: Board;
  id: string;
  forecast: ZoneForecast | undefined;
  options: RouteOption[];
  actions: PanelActions;
}) {
  const zone = board.zones.find((z) => z.id === id);
  if (!zone) return null;
  const c = zoneCounts(zone, board.minute);
  const status = zone.overrunAt !== null ? "Overrun" : zone.orderedAt !== null ? "Evacuating" : "No order";
  const slack = forecast?.coreEta != null ? forecast.coreEta - DEPARTURE_SPREAD_MINUTES : null;
  return (
    <>
      <div className="dm-tags">
        <Tag tone={zone.overrunAt !== null ? "danger" : zone.orderedAt !== null ? "warning" : "neutral"}>{status}</Tag>
        {forecast?.edgeEta != null && zone.overrunAt === null ? <Tag tone="warning">At risk</Tag> : null}
      </div>
      <Facts
        items={[
          { label: "Households", value: nf(zone.households) },
          { label: "At home", value: nf(c.home) },
          { label: "On the road", value: nf(c.enRoute) },
          { label: "Out", value: nf(c.out) },
          { label: "Caught by fire", value: nf(c.caught) },
          { label: "No vehicle", value: `${nf(zone.noVehicle)} households, need transport` },
          { label: "Fire at edge", value: eta(forecast?.edgeEta ?? null) },
          { label: "Fire at core", value: eta(forecast?.coreEta ?? null) },
          ...(slack !== null && zone.orderedAt === null
            ? [{ label: "Time left to order", value: slack < 0 ? `${-slack} min late` : `${slack} min` }]
            : []),
          ...(zone.route ? [{ label: "Route", value: `${zone.route.name}, ${zone.route.eta_min} min drive` }] : []),
        ]}
      />
      {zone.overrunAt === null ? (
        options.length ? (
          <div className="dm-options" role="group" aria-label="Evacuation routes">
            {options.map((o) => (
              <Button
                key={o.destination_id}
                size="sm"
                variant={zone.route?.destination_id === o.destination_id ? "soft" : "secondary"}
                disabled={zone.route?.destination_id === o.destination_id}
                onClick={() => actions.orderZone(zone.id, o.destination_id)}
              >
                {zone.orderedAt === null ? "Evacuate via" : "Redirect to"} {o.name} · {o.eta_min} min · {SAFETY[o.safety]}
              </Button>
            ))}
          </div>
        ) : (
          <Notice compact>No route options yet.</Notice>
        )
      ) : null}
      <p className="dm-note">
        After an order {Math.round(ORDER_COMPLIANCE * 100)}% of households with a vehicle leave, after{" "}
        {DEPARTURE_SPREAD_MINUTES} min on average; with no order, {Math.round(SHADOW_SHARE * 100)}% leave once fire
        reaches the zone. Households without a vehicle stay. Those still home when fire reaches the zone core are caught.
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
          { label: "Home base", value: station ? `${station.name}${station.type === "synthetic" ? " (synthetic)" : ""}` : "None" },
          { label: "Line", value: `${unitLineOn(board, team, fire).toFixed(1)} m/min here` },
          { label: "Holds flames up to", value: `${holdsFlameFeet(team.kind)} ft` },
          ...(team.status === "en_route"
            ? [{ label: "Travel time", value: team.travel === "straight_line" ? "Straight-line estimate" : "Road network" }]
            : []),
        ]}
      />
      {team.status !== "available" ? (
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
  onClose,
}: {
  board: Board;
  selection: Selection;
  forecasts: Map<string, ZoneForecast>;
  routes: ReadonlyMap<string, RouteOption[]>;
  actions: PanelActions;
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
        />
      ) : null}
      {selection.kind === "team" ? <TeamDetail board={board} id={selection.id} actions={actions} /> : null}
    </section>
  );
}
