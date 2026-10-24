import type { ReactNode } from "react";
import { LEVEL_COLOR, MAP_COLOR } from "./CommandMap";

/** What each map mark means; swatches are drawn with the map's own colours. */
const ROWS: { key: string; label: string; swatch: ReactNode }[] = [
  {
    key: "fire",
    label: "Fire estimate",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <defs>
          <pattern id="lc-lg-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="5" stroke={MAP_COLOR.fireEdge} strokeWidth="2" />
          </pattern>
        </defs>
        <rect x="1" y="1" width="18" height="12" rx="2" fill={MAP_COLOR.fire} fillOpacity="0.35" />
        <rect x="1" y="1" width="18" height="12" rx="2" fill="url(#lc-lg-hatch)" fillOpacity="0.6" stroke={MAP_COLOR.fireEdge} strokeWidth="2" strokeDasharray="3 2" />
      </svg>
    ),
  },
  {
    key: "leave",
    label: "Leave now zone",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <rect x="1" y="1" width="18" height="12" rx="2" fill={LEVEL_COLOR.evacuate_now} fillOpacity="0.15" stroke={LEVEL_COLOR.evacuate_now} strokeWidth="2" />
      </svg>
    ),
  },
  {
    key: "ready",
    label: "Be ready zone",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <rect x="1" y="1" width="18" height="12" rx="2" fill={LEVEL_COLOR.be_ready} fillOpacity="0.15" stroke={LEVEL_COLOR.be_ready} strokeWidth="2" />
      </svg>
    ),
  },
  {
    key: "route",
    label: "Planned route",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <line x1="1" y1="7" x2="19" y2="7" stroke={MAP_COLOR.route} strokeWidth="2" strokeDasharray="4 3" strokeOpacity="0.75" />
      </svg>
    ),
  },
  {
    key: "traffic",
    label: "Cars on the road (simulated)",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <line x1="1" y1="7" x2="19" y2="7" stroke="#fff" strokeWidth="8" strokeLinecap="round" />
        <line x1="1" y1="7" x2="19" y2="7" stroke={MAP_COLOR.route} strokeWidth="5" strokeLinecap="round" />
        <line x1="2" y1="7" x2="18" y2="7" stroke={MAP_COLOR.routeFlow} strokeWidth="1.5" strokeDasharray="3 3" />
      </svg>
    ),
  },
  {
    key: "slow",
    label: "Slow traffic (simulated)",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <line x1="1" y1="7" x2="19" y2="7" stroke="#fff" strokeWidth="8" strokeLinecap="round" />
        <line x1="1" y1="7" x2="19" y2="7" stroke={MAP_COLOR.trafficSlow} strokeWidth="5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: "blocked",
    label: "Blocked road",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <line x1="2" y1="7" x2="18" y2="7" stroke="#fff" strokeWidth="8" strokeLinecap="round" />
        <line x1="2" y1="7" x2="18" y2="7" stroke={MAP_COLOR.hazard} strokeWidth="4.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: "queue",
    label: "Traffic queue (simulated)",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <circle cx="10" cy="7" r="5" fill="none" stroke={MAP_COLOR.queue} strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    key: "report",
    label: "Report, confirmed",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <circle cx="6" cy="7" r="4.5" fill="#fff" stroke={MAP_COLOR.report} strokeWidth="2" />
        <circle cx="15" cy="7" r="4.5" fill={MAP_COLOR.hazard} stroke="#fff" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    key: "ground",
    label: "2018 calls and radio, last 30 min",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <circle cx="10" cy="7" r="6" fill={MAP_COLOR.ground} stroke="#fff" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    key: "help",
    label: "Help request",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <circle cx="10" cy="7" r="5" fill="none" stroke={MAP_COLOR.help} strokeWidth="2.5" />
      </svg>
    ),
  },
  {
    key: "responder",
    label: "Responder",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <circle cx="10" cy="7" r="4.5" fill={MAP_COLOR.responder} stroke="#fff" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    key: "shelter",
    label: "Shelter or refuge",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <circle cx="10" cy="7" r="4" fill="#fff" stroke={MAP_COLOR.shelter} strokeWidth="2" />
      </svg>
    ),
  },
];

export default function MapLegend() {
  return (
    <details className="lc-legend" open>
      <summary>Legend</summary>
      <ul>
        {ROWS.map((r) => (
          <li key={r.key}>
            <span className="lc-legend-sw">{r.swatch}</span>
            {r.label}
          </li>
        ))}
      </ul>
    </details>
  );
}
