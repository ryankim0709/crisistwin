import { Button, Notice } from "../ui";
import { useMemo } from "react";
import { areaCenter, arrivalAt, inArea, nearestDestinations, zoneAt } from "./insights";
import { closedEdgesAt, formatAge, lastAtOrBefore, localTime, zoneStatesAt } from "./timeline";
import type { LngLat, ReplayModel } from "./types";

const NEAREST_COUNT = 3;

export interface EvacueeTabProps {
  model: ReplayModel;
  simTimeMs: number;
  frameIndex: number;
  pin: LngLat | null;
  onPin: (p: LngLat | null) => void;
}

/** Point lookup for the evacuee view. Everything here is modelled and phrased non-directively. */
export default function EvacueeTab({ model, simTimeMs, frameIndex, pin, onPin }: EvacueeTabProps) {
  const tz = model.incident.timezone;
  const zones = model.zones?.items ?? [];
  const closed = useMemo(
    () => (model.traffic ? closedEdgesAt(model.traffic.closures, frameIndex) : []),
    [model, frameIndex],
  );
  const zone = useMemo(() => (pin ? zoneAt(zones, pin) : null), [zones, pin]);
  const nearest = useMemo(
    () => (pin ? nearestDestinations(model, pin, closed, NEAREST_COUNT) : []),
    [model, pin, closed],
  );
  const eventIndex = lastAtOrBefore(model.events, simTimeMs);
  const zoneState = zone ? zoneStatesAt(model.events, eventIndex).get(zone.id) : undefined;
  const orderEvent = zone
    ? model.events.find(
        (e, i) => i <= eventIndex && e.zoneIds.includes(zone.id) && e.type.includes("order"),
      )
    : undefined;
  const grid = model.fireSimulated?.arrivalGrid ?? null;
  const arrival = pin && grid ? arrivalAt(grid, pin) : null;
  const perimeterIndex = lastAtOrBefore(model.perimeters, simTimeMs);
  const insidePerimeter =
    pin && perimeterIndex >= 0 ? inArea(model.perimeters[perimeterIndex].geometry, pin) : null;

  return (
    <div className="rp-tab">
      <Notice tone="info">
        {model.insights?.disclaimer ?? "Planning insight from a simulated historical run."}
      </Notice>

      <div className="rp-pin-controls">
        <p className="rp-pin-hint">
          {pin
            ? "Pin placed. Click the map to move it."
            : "Click or tap the map to place a pin, or choose a zone:"}
        </p>
        {zones.length > 0 && (
          <label className="rp-select-label">
            <span className="rp-sr">Place pin at zone</span>
            <select
              className="rp-select"
              value=""
              onChange={(e) => {
                const z = zones.find((item) => item.id === e.target.value);
                if (z) onPin(areaCenter(z.geometry));
              }}
            >
              <option value="">Place pin at a zone…</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {pin && (
          <Button variant="secondary" size="sm" onClick={() => onPin(null)}>
            Clear pin
          </Button>
        )}
      </div>

      {pin && (
        <dl className="rp-facts">
          <dt>Location</dt>
          <dd className="rp-mono">
            {pin[1].toFixed(4)}, {pin[0].toFixed(4)}
          </dd>

          <dt>Modelled fire arrival</dt>
          <dd>
            {!grid && "No simulated fire in this bundle."}
            {arrival?.status === "outside" && "Outside the modelled fire area."}
            {arrival?.status === "not_reached" && "Not reached during the model run."}
            {arrival?.status === "reached" &&
              (arrival.atMs > simTimeMs ? (
                <>
                  {localTime(arrival.atMs, tz)} —{" "}
                  <strong>{formatAge(arrival.atMs - simTimeMs)}</strong> after the replay clock
                </>
              ) : (
                <>
                  {localTime(arrival.atMs, tz)} — already reached in the model,{" "}
                  {formatAge(simTimeMs - arrival.atMs)} before the replay clock
                </>
              ))}
            {grid && <small>From a fire-spread model run; real spread differed.</small>}
          </dd>

          <dt>Satellite perimeter</dt>
          <dd>
            {insidePerimeter === null
              ? "No satellite perimeter in effect yet."
              : insidePerimeter
                ? "Inside the satellite perimeter in effect."
                : "Outside the satellite perimeter in effect."}
          </dd>

          <dt>Zone</dt>
          <dd>
            {zone ? (
              <>
                {zone.name}:{" "}
                {zoneState === "ordered"
                  ? `evacuation order in the replay${orderEvent ? ` since ${localTime(orderEvent.atMs, tz)}` : ""}`
                  : zoneState === "warned"
                    ? "warning in the replay"
                    : "no order yet in the replay"}
                {model.layerStatus.zones?.status === "fixture" && (
                  <small>Zones and orders are synthetic fixtures.</small>
                )}
              </>
            ) : (
              "Not inside a modelled zone."
            )}
          </dd>

          <dt>Nearest destinations (straight line)</dt>
          <dd>
            {nearest.length === 0 ? (
              "No destinations in this bundle."
            ) : (
              <ul className="rp-rows">
                {nearest.map((d) => (
                  <li key={d.id} className="rp-row-static">
                    <span className="rp-row-main">{d.name}</span>
                    <span className="rp-row-side">
                      {(d.distanceM / 1000).toFixed(1)} km ·{" "}
                      {d.closureNearby
                        ? "modelled closure near this exit"
                        : "no modelled closure near this exit"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <small>
              Closures are checked within 150 m of each exit at the current replay time; full routes
              are not evaluated.
            </small>
          </dd>
        </dl>
      )}
    </div>
  );
}
