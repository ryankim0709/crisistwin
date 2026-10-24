import { EvidenceTag, Facts, Tag, type TagTone } from "../ui";
import type { MapFocus } from "./CommandMap";
import {
  FUEL_LABEL,
  HOLD_BAND_LABEL,
  MOISTURE_LABEL,
  apparatusShort,
  canHold,
  holdBand,
  noVehicleAtRisk,
  type HeadRates,
  type HoldBand,
} from "./fireBehavior";
import { drillClock, labelPoint, nf, plural, shortZoneName } from "./format";
import type { CommandResponse, FireBehaviorResponse, FireBehaviorWind } from "./types";
import "./response.css";

const BAND_TONE: Record<HoldBand, TagTone> = { hand: "success", machine: "warning", serious: "danger", indirect: "danger" };
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
const ms = (v: number) => `${v.toFixed(1)} m/s`;

function WindValue({ wind }: { wind: FireBehaviorWind }) {
  const station = wind.station;
  const where = station?.name ? `${station.name}${station.id ? ` (${station.id})` : ""}` : "Station unknown";
  const dist = station?.distance_km != null ? `, ${Math.round(station.distance_km)} km` : "";
  const height = station?.source === "iem_hads" ? "20 ft" : "10 m scaled to 20 ft";
  return (
    <span className="fb-val">
      <span className="fb-line">
        <strong className="lc-num">
          {ms(wind.speed_20ft_ms)}
          {wind.from_deg != null ? ` from ${compass(wind.from_deg)} (${Math.round(wind.from_deg)}°)` : " calm"}
        </strong>
        {wind.gust_ms != null ? <span className="lc-num"> gust {ms(wind.gust_ms)}</span> : null}
        <EvidenceTag kind={wind.evidence_class} />
      </span>
      <small>
        {where}
        {dist}, {height}, {drillClock(wind.t_utc)}
        {wind.held_from ? ` (no report; ${drillClock(wind.held_from)} held)` : ""}
      </small>
    </span>
  );
}

/** Units on the drill with a declared apparatus, by kind, and whether their line holds the head. */
function Units({ data, flameFeet }: { data: CommandResponse; flameFeet: number }) {
  const byKind = new Map<string, { n: number; sim: number }>();
  for (const r of data.responders) {
    const kind = r.apparatus?.kind;
    if (!kind || !apparatusShort(kind)) continue;
    const row = byKind.get(kind) ?? { n: 0, sim: 0 };
    row.n += 1;
    row.sim += r.simulated ? 1 : 0;
    byKind.set(kind, row);
  }
  if (byKind.size === 0) return null;
  return (
    <ul className="fb-units">
      {[...byKind].map(([kind, { n, sim }]) => {
        const hold = canHold(kind, flameFeet);
        return (
          <li key={kind}>
            <span className="lc-num">
              {nf(n)} {apparatusShort(kind)}
              {sim === n ? " (sim)" : sim ? ` (${nf(sim)} sim)` : ""}
            </span>
            {hold == null ? <Tag>No line</Tag> : <Tag tone={hold ? "success" : "danger"}>{hold ? "Can hold" : "Cannot hold"}</Tag>}
          </li>
        );
      })}
    </ul>
  );
}

/** Fire behaviour at the head of the drill's fire: observed wind and slope in, Rothermel rate and
 * flame length out (model), what can hold it, and carless households in harm's way (ACS). */
export default function FireBehaviorPanel({
  inputs,
  error,
  head,
  data,
  onFocus,
}: {
  inputs: FireBehaviorResponse | null;
  error: string | null;
  head: HeadRates | null;
  data: CommandResponse;
  onFocus: (focus: MapFocus) => void;
}) {
  if (!inputs) {
    return error ? (
      <details className="sp" open>
        <summary>Fire behaviour</summary>
        <p className="sp-empty">{error}</p>
      </details>
    ) : null;
  }
  if (!inputs.available) return null;
  const band = head ? holdBand(head.headFlameFeet) : null;
  const zones = new Map(data.zones.map((z) => [z.id, z]));
  const noVehicle = noVehicleAtRisk(inputs, data.guidance);
  const noVehicleTotal = noVehicle.reduce((s, z) => s + z.households, 0);
  const slope = inputs.head
    ? inputs.head.terrain === "observed"
      ? `slope ${Math.round(inputs.head.slope_tan * 100)}% (3DEP)`
      : "flat (assumed)"
    : null;

  const facts = [
    {
      label: "Wind",
      value: inputs.wind ? <WindValue wind={inputs.wind} /> : <span className="lc-dim">{inputs.wind_detail ?? "Unavailable"}</span>,
    },
  ];
  if (head) {
    facts.push({
      label: "Head",
      value: (
        <span className="fb-val">
          <span className="fb-line">
            <strong className="lc-num">
              {head.headMetersPerMinute.toFixed(0)} m/min · {head.headFlameFeet.toFixed(0)} ft flame
            </strong>
            <Tag tone="warning">Model</Tag>
          </span>
          <small>
            Rothermel; {FUEL_LABEL}, {MOISTURE_LABEL}, {slope}
          </small>
        </span>
      ),
    });
  }

  return (
    <details className="sp" open>
      <summary>Fire behaviour</summary>
      <Facts items={facts} />
      {band && head ? (
        <>
          <p className="fb-hold">
            <Tag tone={BAND_TONE[band]}>{band === "hand" ? "≤ 4 ft" : band === "machine" ? "4–8 ft" : band === "serious" ? "8–11 ft" : "> 11 ft"}</Tag>{" "}
            {HOLD_BAND_LABEL[band]}
          </p>
          <Units data={data} flameFeet={head.headFlameFeet} />
        </>
      ) : null}
      {noVehicle.length ? (
        <div className="fb-carless">
          <p className="fb-line">
            <strong>No vehicle: {plural(noVehicleTotal, "household")}</strong>
            <EvidenceTag kind="observed" />
            <span className="sp-meta">ACS</span>
          </p>
          <ul className="sp-list">
            {noVehicle.map((z) => {
              const zone = zones.get(z.zoneId);
              const coord = zone ? labelPoint(zone.geometry) : null;
              return (
                <li key={z.zoneId}>
                  <button
                    type="button"
                    className="sp-row"
                    disabled={!coord}
                    onClick={() => coord && onFocus({ id: `zone:${z.zoneId}`, coord })}
                  >
                    <span className="sp-head">
                      <strong>{zone ? shortZoneName(zone.name) : z.zoneId}</strong>
                      <span className="sp-meta">
                        {nf(z.households)}
                        {z.moe != null ? ` ±${nf(z.moe)}` : ""}
                      </span>
                      {z.fire ? <Tag tone="danger">Fire</Tag> : null}
                      {z.order ? <Tag tone="warning">Order</Tag> : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </details>
  );
}
