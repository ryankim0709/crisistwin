import type { ReactNode } from "react";
import { EvidenceTag, Facts, LoadingState, Notice, Tag } from "../ui";
import type { PollState } from "./usePoll";
import type {
  EngineStatus,
  ScenarioSnapshot,
  SnapshotBasis,
  SnapshotZone,
} from "./scenarioSnapshot";

const nf = (n: number) => n.toLocaleString("en-US");
/** A count that may be unknown: null is shown as "unknown", never 0. */
const known = (n: number | null) => (n === null ? "unknown" : nf(n));

/**
 * Snapshot basis -> kit EvidenceTag kind. observed -> "observed". synthetic -> "fixture": the
 * homes, occupants, vehicles and engines are generated stand-ins, not measurements. estimated ->
 * "derived": computed from other data by stated assumptions (the kit has no "estimated"; "derived"
 * is the most honest fit and is never styled as observed). unknown -> a neutral "Unknown" tag.
 */
export function BasisTag({ basis }: { basis: SnapshotBasis | undefined }) {
  if (basis === "observed") return <EvidenceTag kind="observed" />;
  if (basis === "synthetic") return <EvidenceTag kind="fixture" />;
  if (basis === "estimated") return <EvidenceTag kind="derived" />;
  return <Tag>Unknown</Tag>;
}

/** One basis for a snapshot field (the API may give a list when sources are mixed). */
function basisOf(snap: ScenarioSnapshot, key: string): SnapshotBasis {
  const b = snap.basis[key];
  const list = Array.isArray(b) ? b : b ? [b] : [];
  // Never present a mix as the strongest member: the weakest claim wins.
  for (const rank of ["unknown", "synthetic", "estimated", "observed"] as const) {
    if (list.includes(rank)) return rank;
  }
  return "unknown";
}

/** "Households and engines: ..." for the board model inputs list. */
export function snapshotInputsLine(snap: ScenarioSnapshot): string {
  const word = (b: SnapshotBasis) => (b === "synthetic" ? "synthetic" : b);
  const cfg = snap.config?.path ?? "tools/snapshot_assumptions.json";
  return `occupants ${word(basisOf(snap, "occupants"))}, vehicles ${word(basisOf(snap, "vehicles"))}, engines ${word(basisOf(snap, "engines"))}, station locations ${word(basisOf(snap, "station_locations"))} (snapshot ${snap.snapshot_id}, ${cfg})`;
}

const ENGINE_STATUS: Record<EngineStatus, string> = {
  available: "Available",
  committed: "Committed",
  out_of_service: "Out of service",
};

function Figure({ label, value, basis, detail }: { label: string; value: ReactNode; basis?: SnapshotBasis; detail?: string }): { label: string; value: ReactNode } {
  return {
    label,
    value: (
      <>
        {value} {basis ? <BasisTag basis={basis} /> : null}
        {detail ? <small className="lc-snap-detail"> {detail}</small> : null}
      </>
    ),
  };
}

function when(iso: string): ReactNode {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return (
    <>
      {/* dateStyle/timeStyle cannot be combined with timeZoneName (RangeError), so spell the fields out. */}
      {d.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      })}
      <small className="lc-snap-detail"> ({d.toISOString().slice(0, 16).replace("T", " ")} UTC)</small>
    </>
  );
}

/** Drawer section: the active drill's resource snapshot (planning simulation, not live data). */
export default function ScenarioResources({ state }: { state: PollState<ScenarioSnapshot | null> }) {
  const snap = state.data;
  return (
    <details className="dm-section lc-board-sec lc-snap" open>
      <summary>
        <h2>Scenario resources</h2>
        <EvidenceTag kind="fixture" />
      </summary>
      {!snap && state.loading ? <LoadingState>Loading the resource snapshot…</LoadingState> : null}
      {!snap && !state.loading && state.error ? (
        state.error.status === 404 ? (
          <Notice tone="info" compact>
            No resource snapshot for this drill. Run: <code>python manage.py live_seed_snapshots</code>
          </Notice>
        ) : (
          <Notice tone="danger" compact>
            Resource snapshot unavailable: {state.error.message}
          </Notice>
        )
      ) : null}
      {snap ? <SnapshotBody snap={snap} /> : null}
    </details>
  );
}

function SnapshotBody({ snap }: { snap: ScenarioSnapshot }) {
  const t = snap.totals;
  const occBasis = basisOf(snap, "occupants");
  const vehBasis = basisOf(snap, "vehicles");
  const engBasis = basisOf(snap, "engines");
  const cfg = snap.config?.path ?? "tools/snapshot_assumptions.json";
  const stations = [...snap.stations].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <p className="dm-note lc-snap-note">
        Planning simulation: {snap.label} Households and engines are synthetic unless a row says observed.
      </p>
      <Facts
        items={[
          { label: "Scenario time (T+0)", value: when(snap.scenario_time) },
          Figure({ label: "Households", value: nf(t.households), basis: basisOf(snap, "household_positions") }),
          Figure({
            label: "People",
            value: known(t.occupants),
            basis: occBasis,
            detail:
              t.unknown_occupant_households > 0
                ? `unknown for ${nf(t.unknown_occupant_households)} households; ${nf(t.known_occupants)} counted`
                : undefined,
          }),
          Figure({
            label: "Vehicles",
            value: known(t.vehicles),
            basis: vehBasis,
            detail: t.unknown_vehicle_households > 0 ? `unknown for ${nf(t.unknown_vehicle_households)} households` : undefined,
          }),
          Figure({ label: "Evacuating vehicles", value: nf(t.evacuating_vehicles), basis: vehBasis }),
          Figure({
            label: "Needing transport",
            value: `${nf(t.needs_transport_households)} households, ${nf(t.needs_transport_occupants)} people`,
            basis: occBasis,
          }),
          Figure({ label: "Stations", value: nf(t.stations), basis: basisOf(snap, "station_locations") }),
          Figure({
            label: "Engines",
            value: `${nf(t.engines_total)} total: ${nf(t.engines_available)} available at start, ${nf(t.engines_committed)} committed, ${nf(t.engines_out_of_service)} out of service`,
            basis: engBasis,
          }),
        ]}
      />
      <div className="ui-table-scroll">
        <table className="ui-table lc-snap-table">
          <caption>
            Fire stations and engines at the drill's start · engine rosters <BasisTag basis={engBasis} />
          </caption>
          <thead>
            <tr>
              <th scope="col">Station</th>
              <th scope="col">Location</th>
              <th scope="col" className="num">Available / total</th>
              <th scope="col">Engines</th>
            </tr>
          </thead>
          <tbody>
            {stations.map((s) => (
              <tr key={s.station_id}>
                <th scope="row">{s.name}</th>
                <td><BasisTag basis={s.basis} /></td>
                <td className="num">
                  {s.engines_available === 0 ? <strong>0 available</strong> : `${s.engines_available} available`} / {s.engines_total}
                </td>
                <td>
                  <ul className="lc-snap-engines">
                    {s.engines.map((e) => (
                      <li key={e.engine_id}>
                        <Tag tone={e.status_at_start === "available" ? "success" : e.status_at_start === "committed" ? "warning" : "danger"}>
                          {e.engine_id}: {ENGINE_STATUS[e.status_at_start]}
                        </Tag>
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 className="lc-snap-sub">Sources</h3>
      <ul className="dm-note dm-inputs">
        {snap.sources.map((src) => (
          <li key={src.id}>
            {src.url ? (
              <a href={src.url} target="_blank" rel="noreferrer">{src.name}</a>
            ) : (
              src.name
            )}
            {" "}({src.license ?? "no license stated"})
          </li>
        ))}
      </ul>
      <p className="dm-note">
        Assumptions: <code>{cfg}</code>, snapshot <code>{snap.snapshot_id}</code>.
        {snap.notes.length ? ` ${snap.notes.join("; ")}.` : ""}
      </p>
      <details className="lc-snap-json">
        <summary>Show assumptions JSON</summary>
        <pre>{JSON.stringify(snap.assumptions, null, 2)}</pre>
      </details>
    </>
  );
}

/** Zone panel rows from the snapshot (undefined zone: nothing to show). */
export function zoneSnapshotItems(zone: SnapshotZone | undefined, snap: ScenarioSnapshot | null | undefined) {
  if (!zone || !snap) return [];
  const occ = basisOf(snap, "occupants");
  const veh = basisOf(snap, "vehicles");
  return [
    Figure({ label: "Households (snapshot)", value: nf(zone.households), basis: basisOf(snap, "household_positions") }),
    Figure({
      label: "People (snapshot)",
      value: known(zone.occupants),
      basis: occ,
      detail: zone.unknown_households > 0 ? `unknown for ${nf(zone.unknown_households)} households` : undefined,
    }),
    Figure({ label: "Vehicles (snapshot)", value: known(zone.vehicles), basis: veh }),
    Figure({ label: "Evacuating vehicles (snapshot)", value: nf(zone.evacuating_vehicles), basis: veh }),
    Figure({
      label: "Needing transport (snapshot)",
      value: `${nf(zone.needs_transport_households)} households, ${nf(zone.needs_transport_occupants)} people`,
      basis: occ,
    }),
  ];
}
