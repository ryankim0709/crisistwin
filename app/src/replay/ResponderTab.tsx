import { EmptyState } from "../ui";
import { memo, useMemo } from "react";
import { roadsCutWithin, type ThreatenedRoad } from "./insights";
import { EvidenceChip } from "./parts";
import { formatAge, localTime } from "./timeline";
import type { LngLat, ReplayModel } from "./types";

const CUT_SOON_S = 30 * 60;
const CUT_LATER_S = 60 * 60;
const LIST_LIMIT = 8;

function signedMinutes(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return `${minutes >= 0 ? "+" : "−"}${formatAge(Math.abs(minutes) * 60_000)}`;
}

/** Risk level as a chip with text and a per-level marker, not color alone. */
export function RiskChip({ level }: { level: string }) {
  const marker =
    level === "critical" ? "!!" : level === "high" ? "!" : level === "elevated" ? "▲" : "○";
  return (
    <span className={`rp-risk rp-risk--${level}`}>
      <span aria-hidden="true">{marker}</span> {level}
    </span>
  );
}

export interface ResponderTabProps {
  model: ReplayModel;
  simTimeMs: number;
  onFocus: (coords: LngLat[]) => void;
}

function edgeCoords(model: ReplayModel, trafficEdges: readonly number[]): LngLat[] {
  const roadById = new Map((model.roads?.items ?? []).map((r) => [r.id, r]));
  const out: LngLat[] = [];
  for (const ti of trafficEdges) {
    const edge = roadById.get(model.traffic?.edgeIds[ti] ?? "");
    if (edge) out.push(...edge.coords);
  }
  return out;
}

function CutList({
  model,
  roads,
  simTimeMs,
  onFocus,
  empty,
}: {
  model: ReplayModel;
  roads: ThreatenedRoad[];
  simTimeMs: number;
  onFocus: (coords: LngLat[]) => void;
  empty: string;
}) {
  if (roads.length === 0) return <p className="rp-empty">{empty}</p>;
  return (
    <ul className="rp-rows">
      {roads.slice(0, LIST_LIMIT).map((road) => (
        <li key={road.name}>
          <button
            type="button"
            className="rp-row-btn"
            onClick={() => onFocus(edgeCoords(model, road.edges))}
          >
            <span className="rp-row-main">{road.name}</span>
            <span className="rp-row-side">in {formatAge(road.firstArrivalMs - simTimeMs)}</span>
          </button>
        </li>
      ))}
      {roads.length > LIST_LIMIT && (
        <li className="rp-row-more">+{roads.length - LIST_LIMIT} more roads</li>
      )}
    </ul>
  );
}

const ZoneTable = memo(function ZoneTable({ model }: { model: ReplayModel }) {
  const insights = model.insights;
  const zoneNames = useMemo(
    () => new Map((model.zones?.items ?? []).map((z) => [z.id, z.name])),
    [model],
  );
  if (!insights || insights.zones.length === 0)
    return <p className="rp-empty">No zone insights in this bundle.</p>;
  const tz = model.incident.timezone;
  return (
    <div className="rp-table-wrap">
      <table className="rp-table">
        <caption className="rp-sr">Modelled zone outcomes</caption>
        <thead>
          <tr>
            <th scope="col">Zone</th>
            <th scope="col">Order</th>
            <th scope="col">Fire (model)</th>
            <th scope="col">Lead time</th>
            <th scope="col">Out before fire</th>
            <th scope="col">Risk</th>
          </tr>
        </thead>
        <tbody>
          {insights.zones.map((z) => {
            const share =
              z.vehicles && z.departedByFireVeh != null
                ? Math.round((z.departedByFireVeh / z.vehicles) * 100)
                : null;
            return (
              <tr key={z.zoneId}>
                <th scope="row">{zoneNames.get(z.zoneId) ?? z.zoneId}</th>
                <td>{localTime(z.orderAtMs, tz)}</td>
                <td>{localTime(z.fireArrivalAtMs, tz)}</td>
                <td>
                  {z.leadTimeS === null ? (
                    "—"
                  ) : (
                    <>
                      {signedMinutes(z.leadTimeS)}
                      <small>{z.leadTimeS >= 0 ? "order first" : "fire first"}</small>
                    </>
                  )}
                </td>
                <td>{share === null ? "—" : `${share}%`}</td>
                <td>
                  <RiskChip level={z.riskLevel} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {insights.zones[0]?.riskRule && <p className="rp-rule">Rule: {insights.zones[0].riskRule}</p>}
    </div>
  );
});

export default function ResponderTab({ model, simTimeMs, onFocus }: ResponderTabProps) {
  const insights = model.insights;
  const minute = Math.floor(simTimeMs / 60_000) * 60_000;
  const soon = useMemo(() => roadsCutWithin(model, minute, CUT_SOON_S), [model, minute]);
  const later = useMemo(
    () =>
      roadsCutWithin(model, minute, CUT_LATER_S).filter(
        (r) => !soon.some((s) => s.name === r.name),
      ),
    [model, minute, soon],
  );
  const destNames = useMemo(
    () => new Map((model.destinations?.items ?? []).map((d) => [d.id, d])),
    [model],
  );

  if (!insights) {
    return (
      <EmptyState title="No planning insights in this bundle">
        Regenerate the bundle with the simulator to compute zone and road insights.
      </EmptyState>
    );
  }
  const tz = model.incident.timezone;
  const destinations = insights.destinations
    .filter((d) => (d.arrivedVeh ?? 0) > 0)
    .sort((a, b) => (b.arrivedVeh ?? 0) - (a.arrivedVeh ?? 0))
    .slice(0, LIST_LIMIT);

  return (
    <div className="rp-tab">
      <p className="rp-disclaimer rp-disclaimer--top">
        <EvidenceChip value={insights.evidenceClass} /> {insights.disclaimer}
      </p>

      {insights.headline.length > 0 && (
        <div className="rp-headline">
          {insights.headline.map((h) => (
            <div key={h.label} className="rp-headline-card">
              <span className="rp-metric-label">{h.label}</span>
              <span className="rp-headline-value">
                {h.value == null
                  ? "—"
                  : h.value.toLocaleString("en-US", { maximumFractionDigits: 1 })}
                {h.unit && <small> {h.unit}</small>}
              </span>
              {h.atMs != null && <span className="rp-insight-at">at {localTime(h.atMs, tz)}</span>}
            </div>
          ))}
        </div>
      )}

      <section aria-labelledby="rp-cut-title">
        <h3 id="rp-cut-title" className="rp-section-title">
          Roads the model expects fire to reach
        </h3>
        <h4 className="rp-subtitle">Within 30 min of {localTime(minute, tz)}</h4>
        <CutList
          model={model}
          roads={soon}
          simTimeMs={simTimeMs}
          onFocus={onFocus}
          empty="None in the model."
        />
        <h4 className="rp-subtitle">In 30–60 min</h4>
        <CutList
          model={model}
          roads={later}
          simTimeMs={simTimeMs}
          onFocus={onFocus}
          empty="None in the model."
        />
      </section>

      <section aria-labelledby="rp-zones-title">
        <h3 id="rp-zones-title" className="rp-section-title">
          Zones (modelled)
        </h3>
        <ZoneTable model={model} />
      </section>

      {insights.bottlenecks.length > 0 && (
        <section aria-labelledby="rp-bottlenecks-title">
          <h3 id="rp-bottlenecks-title" className="rp-section-title">
            Bottlenecks (modelled)
          </h3>
          <ul className="rp-rows">
            {insights.bottlenecks.slice(0, LIST_LIMIT).map((b) => (
              <li key={b.edgeId}>
                <button
                  type="button"
                  className="rp-row-btn"
                  onClick={() => {
                    const ti = model.traffic?.edgeIds.indexOf(b.edgeId) ?? -1;
                    if (ti >= 0) onFocus(edgeCoords(model, [ti]));
                  }}
                >
                  <span className="rp-row-main">{b.name ?? b.edgeId}</span>
                  <span className="rp-row-side">
                    peak {b.peakVeh ?? "—"} veh · {b.minutesCongested ?? "—"} min congested
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {destinations.length > 0 && (
        <section aria-labelledby="rp-dest-title">
          <h3 id="rp-dest-title" className="rp-section-title">
            Destination load (modelled, end of run)
          </h3>
          <ul className="rp-rows">
            {destinations.map((d) => {
              const dest = destNames.get(d.destinationId);
              return (
                <li key={d.destinationId}>
                  <button
                    type="button"
                    className="rp-row-btn"
                    onClick={() => dest && onFocus([dest.coord])}
                  >
                    <span className="rp-row-main">{dest?.name ?? d.destinationId}</span>
                    <span className="rp-row-side">
                      {(d.arrivedVeh ?? 0).toLocaleString("en-US")} veh
                      {d.capacityVeh != null && ` of ${d.capacityVeh}`}
                      {d.fullAtMs != null && ` · full at ${localTime(d.fullAtMs, tz)}`}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
