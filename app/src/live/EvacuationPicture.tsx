import { useMemo } from "react";
import { EvidenceTag, LoadingState, Notice, Tag } from "../ui";
import type { LiveError } from "./api";
import type { MapFocus } from "./CommandMap";
import { labelPoint, nf, plural, shortZoneName } from "./format";
import { routeUsesSegment } from "./geo";
import Plate from "./Plate";
import { destinationLoad, NEAR_FULL, type DestLoad } from "./load";
import { wayOut } from "./ProposalPanel";
import type {
  CommandResponse,
  CommandZone,
  TwinEdge,
  TwinMonitor,
  ZoneGuidance,
} from "./types";

const ZONE_ROWS = 6;
const ROAD_ROWS = 5;
const LOAD_ROWS = 8;
const EXPOSED_PREFIX = "Least-exposure route";
const LEVEL_RANK = { evacuate_now: 0, be_ready: 1, none: 2 } as const;

interface ZoneRow {
  zone: CommandZone;
  g: ZoneGuidance;
  remaining: number;
  out: number;
  help: number;
  problem: string | null;
}

interface Problem {
  text: string;
  zones: string[];
}

/** Lost and blocked routes before exposed ones. */
const PROBLEM_RANK = (text: string) => (text === "No open route" ? 0 : text.startsWith("Crosses") ? 1 : 2);

function problemOf(g: ZoneGuidance, blocks: { name: string; line: [number, number][] }[]): string | null {
  if (g.no_route) return "No open route";
  const crossed = g.route ? blocks.find((b) => routeUsesSegment(b.line, g.route!.line)) : undefined;
  if (crossed) return `Crosses the ${crossed.name} block`;
  const safety = g.route?.safety;
  if (safety === "passes_fire") return "Passes the fire";
  if (safety === "passes_near_fire") return "Passes near the fire";
  if (!safety && g.reason.startsWith(EXPOSED_PREFIX)) return /near/.test(g.reason) ? "Passes near the fire" : "Passes the fire";
  return null;
}

function roads(edges: TwinEdge[]) {
  const groups = new Map<string, { name: string; queued: number; worst: TwinEdge }>();
  for (const e of edges) {
    const name = e.name ?? "Unnamed road";
    const g = groups.get(name);
    if (!g) groups.set(name, { name, queued: e.queued_veh, worst: e });
    else {
      g.queued += e.queued_veh;
      if (e.speed_kph / e.free_flow_kph < g.worst.speed_kph / g.worst.free_flow_kph) g.worst = e;
    }
  }
  return [...groups.values()].sort((a, b) => b.queued - a.queued).slice(0, ROAD_ROWS);
}

function TwinDetails({
  twin,
  error,
  zones,
  onFocus,
}: {
  twin: TwinMonitor | null;
  error: LiveError | null;
  zones: CommandZone[];
  onFocus: (f: MapFocus) => void;
}) {
  const names = useMemo(() => new Map(zones.map((z) => [z.id, z.name])), [zones]);
  if (!twin) {
    return error && error.code !== "twin_warming" ? (
      <Notice tone="danger" compact>
        {error.code === "twin_failed" ? "Twin unavailable; proposals use the rule planner." : error.message}
      </Notice>
    ) : (
      <LoadingState>Loading the twin…</LoadingState>
    );
  }
  const moving = twin.zones
    .filter((z) => z.ordered_at !== null || z.en_route_veh > 0 || z.arrived_veh > 0)
    .sort((a, b) => b.not_departed_veh + b.en_route_veh - (a.not_departed_veh + a.en_route_veh))
    .slice(0, 8);
  const queues = roads(twin.congested_edges);
  const t = twin.totals;
  return (
    <div className="lc-twin">
      {!twin.conserved ? (
        <Notice tone="danger" compact>
          Vehicle counts do not add up; treat this twin snapshot as unreliable.
        </Notice>
      ) : null}
      <dl className="lc-facts">
        <div>
          <dt>Not departed</dt>
          <dd>{nf(t.not_departed_veh)}</dd>
        </div>
        <div>
          <dt>Blocked</dt>
          <dd>{nf(t.blocked_veh)}</dd>
        </div>
        <div>
          <dt>Exposed</dt>
          <dd>{nf(t.exposed_veh)}</dd>
        </div>
      </dl>
      {moving.length ? (
        <>
          <h4>Zones moving</h4>
          <ul className="lc-bars">
            {moving.map((z) => {
              const name = shortZoneName(names.get(z.id) ?? z.id);
              const label = `${name}: ${nf(z.arrived_veh)} arrived, ${nf(z.en_route_veh)} en route, ${nf(z.not_departed_veh)} not departed`;
              return (
                <li key={z.id} title={label} aria-label={label}>
                  <span className="lc-bars-name">{name}</span>
                  <span className="lc-bars-bar" aria-hidden="true">
                    <span className="lc-bars-arrived" style={{ flexGrow: z.arrived_veh }} />
                    <span className="lc-bars-enroute" style={{ flexGrow: z.en_route_veh }} />
                    <span className="lc-bars-home" style={{ flexGrow: z.not_departed_veh }} />
                  </span>
                  <span className="lc-num">{Math.round((z.arrived_veh / Math.max(1, z.vehicles)) * 100)}% out</span>
                </li>
              );
            })}
          </ul>
          <p className="lc-bars-key" aria-hidden="true">
            <span className="lc-bars-arrived" /> Arrived <span className="lc-bars-enroute" /> En route{" "}
            <span className="lc-bars-home" /> Not departed
          </p>
        </>
      ) : null}
      <h4>Queues</h4>
      {queues.length === 0 ? (
        <p className="lc-dim">No queues</p>
      ) : (
        <ul className="lc-plain">
          {queues.map((r) => (
            <li key={r.name}>
              <button
                type="button"
                className="lc-linkrow"
                onClick={() => onFocus({ id: `edge:${r.worst.edge_index}`, coord: r.worst.coord })}
              >
                <span>{r.name}</span>
                <span className="lc-num">{nf(r.queued)} queued</span>
                <span className="lc-num lc-dim">
                  {Math.round(r.worst.speed_kph)} of {Math.round(r.worst.free_flow_kph)} km/h
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {twin.destinations.length ? (
        <>
          <h4>Arrivals</h4>
          <ul className="lc-plain">
            {twin.destinations.slice(0, 6).map((d) => (
              <li key={d.id} className="lc-split">
                <span>{d.name}</span>
                <span className="lc-num">
                  {nf(d.arrived_veh)}
                  {d.capacity_veh !== null ? ` of ${nf(d.capacity_veh)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

export default function EvacuationPicture({
  data,
  twin,
  twinError,
  onFocus,
}: {
  data: CommandResponse;
  twin: TwinMonitor | null;
  twinError: LiveError | null;
  onFocus: (f: MapFocus) => void;
}) {
  const model = useMemo(() => {
    const counts = new Map(data.checkins.by_zone.map((c) => [c.zone_id, c]));
    const guidance = new Map(data.guidance.map((g) => [g.zone_id, g]));
    const blocks = data.public_items
      .filter((i) => i.kind === "road_blocked" && i.line && i.line.length > 1)
      .map((i) => ({ name: i.road_ref?.name ?? "road", line: i.line! as [number, number][] }));
    let remaining = 0;
    let out = 0;
    const rows: ZoneRow[] = [];
    for (const zone of data.zones) {
      const c = counts.get(zone.id);
      const zoneOut = c?.out ?? 0;
      const left = Math.max(0, zone.households - zoneOut);
      remaining += left;
      out += zoneOut;
      const g = guidance.get(zone.id);
      if (!g || g.level === "none") continue;
      rows.push({ zone, g, remaining: left, out: zoneOut, help: c?.need_help ?? 0, problem: problemOf(g, blocks) });
    }
    rows.sort(
      (a, b) =>
        Number(!!b.problem) - Number(!!a.problem) ||
        LEVEL_RANK[a.g.level] - LEVEL_RANK[b.g.level] ||
        b.remaining - a.remaining,
    );
    const byProblem = new Map<string, string[]>();
    for (const r of rows) {
      if (r.problem) byProblem.set(r.problem, [...(byProblem.get(r.problem) ?? []), shortZoneName(r.zone.name)]);
    }
    for (const e of twin?.command_errors ?? []) {
      if (e.code !== "fallback_unreachable") continue;
      const zone = data.zones.find((z) => e.key === `unreachable:${z.id}`);
      const label = "Destination unreachable in the twin";
      byProblem.set(label, [...(byProblem.get(label) ?? []), zone ? shortZoneName(zone.name) : e.key]);
    }
    const problems: Problem[] = [...byProblem.entries()]
      .map(([text, zones]) => ({ text, zones }))
      .sort((a, b) => PROBLEM_RANK(a.text) - PROBLEM_RANK(b.text) || b.zones.length - a.zones.length);
    const shelters = data.destinations.filter((d) => d.kind === "shelter");
    const refuges = data.destinations.filter((d) => d.kind === "temporary_refuge");
    const withCapacity = data.destinations.filter((d) => d.capacity_veh !== null);
    const full = data.public_items.filter((i) => i.kind === "shelter_full");
    const reportedFull = data.reports.filter(
      (r) => r.kind === "shelter_full" && r.status !== "dismissed" && r.status !== "resolved",
    );
    const load = destinationLoad(data, twin).filter(
      (r) => r.zones > 0 || r.phones > 0 || r.reportedFull || (r.simArrivedVeh ?? 0) > 0,
    );
    return { rows, problems, remaining, out, shelters, refuges, withCapacity, full, reportedFull, load };
  }, [data, twin]);

  const help = data.checkins.need_help.length;
  const focusZone = (zone: CommandZone) => {
    const coord = labelPoint(zone.geometry);
    if (coord) onFocus({ id: zone.id, coord });
  };
  const destName = (id: string | null) => (id ? (data.destinations.find((d) => d.id === id)?.name ?? id) : "Shelter");
  const fullNames = [
    ...new Set([
      ...model.full.map((i) => destName(i.destination_id ?? null)),
      ...model.reportedFull.map((r) => destName(r.destination_id)),
    ]),
  ];
  const twinFull = (twin?.destinations ?? []).filter((d) => d.capacity_veh !== null && d.remaining_capacity_veh === 0);
  const rest = model.rows.slice(ZONE_ROWS);
  const zoneRow = (r: ZoneRow) => (
    <li key={r.zone.id}>
      <button type="button" className="lc-zone" onClick={() => focusZone(r.zone)}>
        <Plate
          level={r.g.level}
          line={r.g.no_route ? "No open route" : wayOut(r.g.destination?.name, r.g.route?.via, r.g.route?.eta_min)}
        />
        <span className="lc-zone-text">
          <strong>{shortZoneName(r.zone.name)}</strong>
          <span className="lc-num">{nf(r.remaining)} households remain</span>
          {r.help ? <span className="lc-zone-help">{plural(r.help, "help request")}</span> : null}
          {r.g.caveat ? <span className="lc-zone-caveat">{r.g.caveat}</span> : null}
        </span>
      </button>
    </li>
  );

  const loadRow = (r: DestLoad) => (
    <tr key={r.id}>
      <th scope="row">
        {r.name}
        {r.reportedFull ? <Tag tone="danger">Reported full</Tag> : null}
        {r.simShare !== null && r.simShare >= NEAR_FULL ? <Tag tone="warning">Twin: {Math.round(r.simShare * 100)}%</Tag> : null}
      </th>
      <td className="lc-num">{nf(r.zones)}</td>
      <td className="lc-num">{nf(r.phones)}</td>
      <td className="lc-num">
        {r.simArrivedVeh === null ? "—" : nf(r.simArrivedVeh)}
        {r.capacityVeh !== null ? ` / ${nf(r.capacityVeh)}` : ""}
      </td>
    </tr>
  );

  return (
    <section className="lc-pic" aria-labelledby="lc-pic-title">
      <header className="lc-col-head">
        <h2 id="lc-pic-title">Evacuation picture</h2>
      </header>
      <dl className="lc-figures">
        <div title={`Bundle households minus ${nf(model.out)} “I’m out” check-ins`}>
          <dt>Households left</dt>
          <dd>{nf(model.remaining)}</dd>
        </div>
        <div title="Open “Need help” check-ins">
          <dt>Need help</dt>
          <dd className={help ? "is-alert" : undefined}>{nf(help)}</dd>
        </div>
        <div title="Simulated vehicles on the road in the traffic twin">
          <dt>Twin en route</dt>
          <dd>{twin ? nf(twin.totals.en_route_veh) : "—"}</dd>
        </div>
        <div title="Simulated vehicles arrived in the traffic twin">
          <dt>Twin arrived</dt>
          <dd>{twin ? nf(twin.totals.arrived_veh) : "—"}</dd>
        </div>
      </dl>

      {model.rows.length === 0 ? (
        <p className="lc-dim">No zone has an order.</p>
      ) : (
        <>
          <ul className="lc-zones" aria-label="Ordered zones">
            {model.rows.slice(0, ZONE_ROWS).map(zoneRow)}
          </ul>
          {rest.length ? (
            <details className="lc-more">
              <summary>{plural(rest.length, "more ordered zone")}</summary>
              <ul className="lc-zones">{rest.map(zoneRow)}</ul>
            </details>
          ) : null}
        </>
      )}

      <h3 className="lc-sub">Blocked or exposed routes</h3>
      {model.problems.length === 0 ? (
        <p className="lc-dim">None</p>
      ) : (
        <ul className="lc-plain lc-problems">
          {model.problems.map((p) => (
            <li key={p.text}>
              <details>
                <summary>
                  {p.text}, <span className="lc-num">{plural(p.zones.length, "zone")}</span>
                </summary>
                <p className="lc-dim">{p.zones.join("; ")}</p>
              </details>
            </li>
          ))}
        </ul>
      )}

      <h3 className="lc-sub">Destination load</h3>
      {model.load.length === 0 ? (
        <p className="lc-dim">None</p>
      ) : (
        <>
          <table className="lc-load">
            <thead>
              <tr>
                <th scope="col">Destination</th>
                <th scope="col" className="lc-num" title="Zones whose current guidance routes here">
                  Zones
                </th>
                <th scope="col" className="lc-num" title="Phones (people) that chose it; not vehicles">
                  Phones
                </th>
                <th scope="col" className="lc-num" title="Simulated vehicles arrived in the traffic twin, of capacity in vehicles">
                  Twin (sim.) veh
                </th>
              </tr>
            </thead>
            <tbody>{model.load.slice(0, LOAD_ROWS).map(loadRow)}</tbody>
          </table>
          {model.load.length > LOAD_ROWS ? (
            <details className="lc-more">
              <summary>{plural(model.load.length - LOAD_ROWS, "more destination")}</summary>
              <table className="lc-load">
                <tbody>{model.load.slice(LOAD_ROWS).map(loadRow)}</tbody>
              </table>
            </details>
          ) : null}
        </>
      )}

      <h3 className="lc-sub">Shelters</h3>
      {model.shelters.length === 0 && model.withCapacity.length === 0 ? (
        <p>
          No shelter data in this bundle.
          {model.refuges.length ? (
            <span className="lc-dim"> {plural(model.refuges.length, "temporary refuge")}, capacity unknown.</span>
          ) : null}
        </p>
      ) : (
        <p>
          {plural(model.shelters.length, "shelter")}, {plural(model.withCapacity.length, "destination")} with capacity.
        </p>
      )}
      {fullNames.length || twinFull.length ? (
        <ul className="lc-plain lc-problems">
          {fullNames.map((n) => (
            <li key={`r:${n}`}>{n}: reported full</li>
          ))}
          {twinFull.map((d) => (
            <li key={`t:${d.id}`}>{d.name}: full in the twin</li>
          ))}
        </ul>
      ) : null}

      <details className="lc-more lc-twin-details">
        <summary>
          Twin details <EvidenceTag kind="simulated" />
        </summary>
        <TwinDetails twin={twin} error={twinError} zones={data.zones} onFocus={onFocus} />
      </details>
    </section>
  );
}
