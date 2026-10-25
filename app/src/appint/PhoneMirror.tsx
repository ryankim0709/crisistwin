import { useMemo } from "react";
import { EmptyState, EvidenceTag, LoadingState, Notice } from "../ui";
import { readToken } from "../live/api";
import { usePhoneView, type PhoneButton, type PhoneView } from "./phoneView";
import "./phone-mirror.css";

type LonLat = [number, number];
const MAP_W = 228;
const MAP_H = 168;
const MAP_PAD = 16;

/** Lon/lat to strip pixels (equirectangular, fitted to the points that matter). */
function fit(points: LonLat[]): (p: LonLat) => [number, number] {
  const lat0 = (points.reduce((s, p) => s + p[1], 0) / points.length) * (Math.PI / 180);
  const kx = Math.cos(lat0);
  const xs = points.map((p) => p[0] * kx);
  const ys = points.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const w = Math.max(Math.max(...xs) - x0, 0.004);
  const h = Math.max(Math.max(...ys) - y0, 0.004);
  const scale = Math.min((MAP_W - 2 * MAP_PAD) / w, (MAP_H - 2 * MAP_PAD - 40) / h);
  const ox = (MAP_W - w * scale) / 2;
  const oy = (MAP_H - 40 - h * scale) / 2 + 40;
  return (p) => [ox + (p[0] * kx - x0) * scale, MAP_H - (oy + (p[1] - y0) * scale)];
}

function MapStrip({ view }: { view: PhoneView }) {
  const person = view.position;
  const route = view.route?.line;
  const target = view.assignment?.target ?? null;
  const destination = view.destination_coord ?? null;
  const geometry = useMemo(() => {
    const focus: LonLat[] = [];
    if (person) {
      focus.push(person);
      // Only the stretch of route near the person, so a long route does not shrink the picture.
      for (const p of route ?? []) if (Math.abs(p[0] - person[0]) < 0.06 && Math.abs(p[1] - person[1]) < 0.06) focus.push(p);
    } else if (route?.length) {
      focus.push(route[0], route[route.length - 1]);
    }
    if (target) focus.push(target);
    if (!focus.length) return null;
    // Nearest fire vertex, so a nearby fire is in view.
    if (view.fire_distance_km !== null && view.fire_distance_km < 25 && person) {
      let best: LonLat | null = null;
      let bestD = Infinity;
      for (const ring of view.fire.rings)
        for (const p of ring) {
          const d = (p[0] - person[0]) ** 2 + (p[1] - person[1]) ** 2;
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        }
      if (best) focus.push(best);
    }
    const project = fit(focus);
    const path = (pts: LonLat[]) =>
      pts
        .map((p, i) => {
          const [x, y] = project(p);
          return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
        })
        .join("");
    return {
      project,
      fire: view.fire.rings.map((r) => `${path(r)}Z`),
      route: route?.length ? path(route) : null,
    };
  }, [person, route, target, view.fire, view.fire_distance_km]);

  const label = person
    ? `Map: ${view.zone?.name ?? "the person"}${view.fire_distance_km !== null ? `, fire ${view.fire_distance_km} km away` : ""}${view.route ? `, route to ${view.route.destination_name}` : ""}`
    : "Map: no position yet";
  return (
    <svg className="pmr-map" viewBox={`0 0 ${MAP_W} ${MAP_H}`} role="img" aria-label={label}>
      <rect width={MAP_W} height={MAP_H} className="pmr-map-bg" />
      {geometry === null ? (
        <text x={MAP_W / 2} y={MAP_H / 2 - 10} textAnchor="middle" className="pmr-map-note">
          No position yet
        </text>
      ) : (
        <>
          {geometry.fire.map((d, i) => (
            <path key={i} d={d} className="pmr-map-fire" />
          ))}
          {geometry.route && <path d={geometry.route} className="pmr-map-route" />}
          {destination && (
            <rect
              x={geometry.project(destination)[0] - 4}
              y={geometry.project(destination)[1] - 4}
              width={8}
              height={8}
              className="pmr-map-dest"
            />
          )}
          {target && (
            <path
              d={`M${geometry.project(target)[0]} ${geometry.project(target)[1] - 6}l6 10h-12z`}
              className="pmr-map-task"
            />
          )}
          {person && (
            <circle
              cx={geometry.project(person)[0]}
              cy={geometry.project(person)[1]}
              r={5}
              className={view.position_is === "device" ? "pmr-map-me" : "pmr-map-me pmr-map-me-approx"}
            />
          )}
        </>
      )}
    </svg>
  );
}

function Buttons({ buttons }: { buttons: PhoneButton[] }) {
  if (!buttons.length) return null;
  return (
    <div className="pmr-buttons">
      {buttons.map((b) => (
        <span key={b.label} className={`pmr-btn pmr-btn-${b.kind}`} aria-disabled="true">
          {b.label}
        </span>
      ))}
    </div>
  );
}

/** A plain-language reading of the screen for the operator, beneath the phone. */
function plain(view: PhoneView, name: string): string {
  const who = view.kind === "simulated" ? `${name} (simulated)` : name;
  const zone = view.zone ? ` in ${view.zone.name}` : "";
  const fire =
    view.fire_distance_km === null
      ? ""
      : view.fire_distance_km === 0
        ? " The fire estimate covers this spot."
        : ` The fire estimate is ${view.fire_distance_km} km away.`;
  switch (view.screen) {
    case "guidance": {
      const to = view.route
        ? ` to ${view.route.destination_name}${view.route.eta_min !== null ? `, about ${view.route.eta_min} min` : ""}`
        : "";
      return `${who}${zone} is told: ${view.sub.toLowerCase()}. ${view.headline}${to}.${fire}`;
    }
    case "no_order":
      return `${who}${zone} has no evacuation order.${fire}`;
    case "checked_out":
      return `${who} has marked themselves out.`;
    case "help_requested":
      return `${who}${zone} asked for help. The app shows "${view.headline}".${fire}`;
    case "responder":
      return view.assignment
        ? `${who} is a responder. Their app shows a task: ${view.headline.toLowerCase()}.`
        : `${who} is a responder with no open tasks.`;
    default:
      return `${who} has not reported a place yet, so the app is still finding their location.`;
  }
}

export interface PhoneMirrorProps {
  incidentId: string;
  participantId: string;
}

/**
 * What the participant's iOS app shows right now: a non-interactive mirror of the phone
 * (map strip, guidance card, check-in buttons), polled every 3 s from the controller-only
 * phone-view endpoint. Contract: docs/app-integration.md "Phone mirror".
 */
export function PhoneMirror({ incidentId, participantId }: PhoneMirrorProps) {
  const token = useMemo(() => readToken(), []);
  const { data, error, loading } = usePhoneView(token, incidentId, participantId);
  const label = data?.name ?? participantId;

  let screen = null;
  if (!data && loading) {
    screen = (
      <div className="pmr-state">
        <LoadingState>Loading phone…</LoadingState>
      </div>
    );
  } else if (!data && error) {
    screen = (
      <div className="pmr-state">
        {error.status === 404 ? (
          <EmptyState title="Unknown participant" symbol="?">
            No phone or simulated person with this id in this incident.
          </EmptyState>
        ) : (
          <Notice tone="danger" title="Cannot read the phone" compact>
            {error.message}
          </Notice>
        )}
      </div>
    );
  } else if (data) {
    screen = (
      <>
        <MapStrip view={data} />
        <div className="pmr-card">
          <div className="pmr-title-row">
            <h3 className="pmr-title">{data.headline || "No instruction"}</h3>
            {data.incident.mode === "exercise" && <span className="pmr-exercise">Exercise</span>}
          </div>
          {data.sub && <p className="pmr-sub">{data.sub}</p>}
          {data.lines.map((line, i) => (
            <p key={i} className={data.screen === "guidance" && /fire|passes/i.test(line) ? "pmr-caveat" : "pmr-line"}>
              {line}
            </p>
          ))}
          {data.zone && <p className="pmr-zone">{data.zone.name}</p>}
          <Buttons buttons={data.buttons} />
        </div>
      </>
    );
  }

  return (
    <figure className="pmr" aria-label={`What ${label} sees`}>
      <div className="pmr-phone">
        <div className="pmr-notch" aria-hidden="true" />
        <div className="pmr-screen">{screen}</div>
      </div>
      <figcaption className="pmr-caption">
        {data && (
          <>
            <p className="pmr-plain">{plain(data, label)}</p>
            <p className="pmr-meta">
              <EvidenceTag kind={data.evidence_class} />
              <span>{data.fire_label}</span>
            </p>
            {error && (
              <Notice tone="warning" compact>
                {error.message} Showing the last view.
              </Notice>
            )}
          </>
        )}
      </figcaption>
    </figure>
  );
}
