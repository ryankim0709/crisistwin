import type { ReactNode } from "react";
import { LEVEL_COLOR, MAP_COLOR } from "../live/CommandMap";

/** Mirrors DEMO_COLOR.scar / scarEdge in DemoMap.tsx. */
const SCAR = "#6B7280";
const SCAR_EDGE = "#4B5563";
const OVERRUN = "#B3140C";

const zoneSwatch = (color: string, opacity: number, width = 2): ReactNode => (
  <svg viewBox="0 0 20 14" aria-hidden="true">
    <rect x="1" y="1" width="18" height="12" rx="2" fill={color} fillOpacity={opacity} stroke={color} strokeWidth={width} />
  </svg>
);

const fireSwatch = (id: string, dashed: boolean): ReactNode => (
  <svg viewBox="0 0 20 14" aria-hidden="true">
    <defs>
      <pattern id={id} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="5" stroke={MAP_COLOR.fireEdge} strokeWidth="2" />
      </pattern>
    </defs>
    <rect x="1" y="1" width="18" height="12" rx="2" fill={MAP_COLOR.fire} fillOpacity={dashed ? 0.18 : 0.35} />
    {!dashed && <rect x="1" y="1" width="18" height="12" rx="2" fill={`url(#${id})`} fillOpacity="0.6" />}
    <rect x="1" y="1" width="18" height="12" rx="2" fill="none" stroke={MAP_COLOR.fireEdge} strokeWidth="2" strokeDasharray={dashed ? "3 2" : undefined} />
  </svg>
);

/** What each map mark means; swatches are drawn with the map's own colours. */
const ROWS: { key: string; label: string; swatch: ReactNode }[] = [
  { key: "burning", label: "Burning fire", swatch: fireSwatch("dm-lg-hatch", false) },
  { key: "contained", label: "Contained fire (dashed edge)", swatch: fireSwatch("dm-lg-hatch-c", true) },
  {
    key: "out",
    label: "Burned out",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <rect x="1" y="1" width="18" height="12" rx="2" fill={SCAR} fillOpacity="0.25" stroke={SCAR_EDGE} strokeWidth="1" />
      </svg>
    ),
  },
  { key: "leave", label: "Leave now zone", swatch: zoneSwatch(LEVEL_COLOR.evacuate_now, 0.15) },
  { key: "risk", label: "At risk zone", swatch: zoneSwatch(LEVEL_COLOR.be_ready, 0.15) },
  { key: "overrun", label: "Overrun zone", swatch: zoneSwatch(OVERRUN, 0.3, 3) },
  {
    key: "route",
    label: "Evacuation route",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <line x1="1" y1="7" x2="19" y2="7" stroke={MAP_COLOR.route} strokeWidth="2" strokeDasharray="4 3" strokeOpacity="0.75" />
      </svg>
    ),
  },
  {
    key: "team",
    label: "Firefighting unit",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <circle cx="10" cy="7" r="5" fill={MAP_COLOR.responder} stroke="#fff" strokeWidth="2" />
      </svg>
    ),
  },
  {
    key: "enroute",
    label: "Unit en route",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <line x1="1" y1="7" x2="19" y2="7" stroke={MAP_COLOR.responder} strokeWidth="1.5" strokeDasharray="2 2" />
        <circle cx="6" cy="7" r="4.5" fill={MAP_COLOR.responder} fillOpacity="0.75" stroke="#fff" strokeWidth="1" />
      </svg>
    ),
  },
  {
    key: "station",
    label: "Station",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <circle cx="10" cy="7" r="4" fill="#fff" stroke={MAP_COLOR.ink} strokeWidth="3" />
      </svg>
    ),
  },
  {
    key: "shelter",
    label: "Shelter",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <circle cx="10" cy="7" r="4" fill="#fff" stroke={MAP_COLOR.shelter} strokeWidth="2" />
      </svg>
    ),
  },
];

export default function DemoLegend() {
  return (
    <details className="lc-legend">
      <summary>Legend</summary>
      <ul>
        {ROWS.map((r) => (
          <li key={r.key}>
            <span className="lc-legend-sw">{r.swatch}</span>
            {r.label}
          </li>
        ))}
      </ul>
      <p className="dm-legend-note">Simulated fires, teams and households. Not real data.</p>
    </details>
  );
}
