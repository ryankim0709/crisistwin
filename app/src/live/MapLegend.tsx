import type { ReactNode } from "react";
import { EvidenceTag } from "../ui";
import { BOARD_COLOR } from "../demo/boardMapLayers";
import { LEVEL_COLOR, MAP_COLOR } from "./CommandMap";

const zoneSw = (color: string, opacity: number, width = 2): ReactNode => (
  <svg viewBox="0 0 20 14" aria-hidden="true">
    <rect x="1" y="1" width="18" height="12" rx="2" fill={color} fillOpacity={opacity} stroke={color} strokeWidth={width} />
  </svg>
);

const boardFireSw = (id: string, dashed: boolean): ReactNode => (
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

/** The simulated board's marks (drawn by demo/boardMapLayers.ts). All simulation output. */
const BOARD_ROWS: { key: string; label: string; swatch: ReactNode }[] = [
  { key: "bd-burning", label: "Burning fire (sim)", swatch: boardFireSw("lc-lg-bd-hatch", false) },
  { key: "bd-contained", label: "Contained fire, dashed edge (sim)", swatch: boardFireSw("lc-lg-bd-hatch-c", true) },
  {
    key: "bd-out",
    label: "Burned-out fire (sim)",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <rect x="1" y="1" width="18" height="12" rx="2" fill={BOARD_COLOR.scar} fillOpacity="0.25" stroke={BOARD_COLOR.scarEdge} strokeWidth="1" />
      </svg>
    ),
  },
  { key: "bd-leave", label: "Board zone: leave now (sim)", swatch: zoneSw(LEVEL_COLOR.evacuate_now, 0.15) },
  { key: "bd-risk", label: "Board zone: at risk (sim)", swatch: zoneSw(LEVEL_COLOR.be_ready, 0.15) },
  { key: "bd-overrun", label: "Board zone: overrun (sim)", swatch: zoneSw(BOARD_COLOR.overrun, 0.3, 3) },
  {
    key: "bd-unit",
    label: "Fire unit (sim)",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <circle cx="10" cy="7" r="5" fill={MAP_COLOR.responder} stroke="#fff" strokeWidth="2" />
      </svg>
    ),
  },
  {
    key: "bd-returning",
    label: "Unit returning to station (sim)",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <line x1="1" y1="7" x2="19" y2="7" stroke={MAP_COLOR.responder} strokeOpacity="0.6" strokeWidth="1.5" strokeDasharray="0.5 2" />
        <circle cx="14" cy="7" r="4.5" fill={MAP_COLOR.responder} fillOpacity="0.55" stroke="#fff" strokeWidth="1" />
      </svg>
    ),
  },
  {
    key: "bd-enroute",
    label: "Unit en route (sim)",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <line x1="1" y1="7" x2="19" y2="7" stroke={MAP_COLOR.responder} strokeWidth="1.5" strokeDasharray="2 2" />
        <circle cx="6" cy="7" r="4.5" fill={MAP_COLOR.responder} fillOpacity="0.75" stroke="#fff" strokeWidth="1" />
      </svg>
    ),
  },
  {
    key: "bd-fireline",
    label: "Fire line ahead of a fire: built solid, planned dashed (sim; a barrier in the fire model)",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <line x1="1" y1="7" x2="10" y2="7" stroke={BOARD_COLOR.fireLine} strokeWidth="3" />
        <line x1="10" y1="7" x2="19" y2="7" stroke={BOARD_COLOR.fireLine} strokeWidth="2" strokeDasharray="3 2" />
      </svg>
    ),
  },
  {
    key: "bd-evac",
    label: "Evacuating vehicles on their road route, one dot per 10+ vehicles (sim)",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <line x1="1" y1="7" x2="19" y2="7" stroke={MAP_COLOR.route} strokeWidth="2" strokeDasharray="3 2" />
        <circle cx="7" cy="7" r="3" fill={BOARD_COLOR.evacuee} stroke="#fff" strokeWidth="1" />
        <circle cx="14" cy="7" r="3" fill={BOARD_COLOR.evacuee} stroke="#fff" strokeWidth="1" />
      </svg>
    ),
  },
  {
    key: "bd-traffic",
    label: "Evacuation route: free / labelled Slow (x1.25+) / Jammed (x2+) in traffic, wider = more cars (sim)",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <line x1="1" y1="3" x2="19" y2="3" stroke={MAP_COLOR.route} strokeWidth="2" strokeDasharray="3 2" />
        <line x1="1" y1="7" x2="19" y2="7" stroke={BOARD_COLOR.trafficSlow} strokeWidth="2.5" strokeDasharray="3 2" />
        <line x1="1" y1="11.5" x2="19" y2="11.5" stroke={BOARD_COLOR.trafficJam} strokeWidth="3" strokeDasharray="3 2" />
      </svg>
    ),
  },
  {
    key: "bd-station",
    label: "Fire station; the number is units parked there (sim)",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <circle cx="10" cy="7" r="6" fill="#C62828" stroke="#fff" strokeWidth="1.5" />
        <text x="10" y="9.6" textAnchor="middle" fontSize="7.5" fill="#fff" fontWeight="700">3</text>
      </svg>
    ),
  },
];

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
    key: "responder-route",
    label: "Responder route",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <line x1="2" y1="7" x2="18" y2="7" stroke={MAP_COLOR.casing} strokeWidth="6" strokeLinecap="round" />
        <line x1="2" y1="7" x2="18" y2="7" stroke={MAP_COLOR.responderRoute} strokeWidth="3" strokeLinecap="round" strokeDasharray="0.1 4" />
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

export default function MapLegend({ record = true, board = false }: { record?: boolean; board?: boolean }) {
  return (
    <details className="lc-legend">
      <summary>Legend</summary>
      <ul>
        {ROWS.filter((r) => record || r.key !== "ground").map((r) => (
          <li key={r.key}>
            <span className="lc-legend-sw">{r.swatch}</span>
            {r.label}
          </li>
        ))}
        {board && (
          <>
            <li className="lc-legend-group">
              Simulated board <EvidenceTag kind="simulated" />
            </li>
            {BOARD_ROWS.map((r) => (
              <li key={r.key}>
                <span className="lc-legend-sw">{r.swatch}</span>
                {r.label}
              </li>
            ))}
          </>
        )}
      </ul>
    </details>
  );
}
