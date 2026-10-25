import type { ReactNode } from "react";
import { EvidenceTag } from "../ui";
import { BOARD_COLOR } from "../demo/boardMapLayers";
import { LEVEL_COLOR, MAP_COLOR } from "./CommandMap";
import { HouseSwatch } from "./HouseholdSummary";
import { HOUSEHOLD_DETAIL, HOUSEHOLD_LABEL } from "./householdLayer";
import { HOUSEHOLD_STATUSES } from "./useHouseholdState";

const zoneSw = (color: string, opacity: number, width = 2): ReactNode => (
  <svg viewBox="0 0 20 14" aria-hidden="true">
    <rect x="1" y="1" width="18" height="12" rx="2" fill={color} fillOpacity={opacity} stroke={color} strokeWidth={width} />
  </svg>
);

/** Fire rows while per-cell fire states are drawn (demo/fireState.ts): what burns, burned out, was put out. */
const FIRE_STATE_ROWS: { key: string; label: string; swatch: ReactNode }[] = [
  {
    key: "bd-fs-burning",
    label: "Burning now: bright fill, thick glowing edge (sim)",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <rect x="2" y="2" width="16" height="10" rx="2" fill={MAP_COLOR.fire} fillOpacity="0.5" stroke={MAP_COLOR.fire} strokeOpacity="0.5" strokeWidth="4" />
        <rect x="2" y="2" width="16" height="10" rx="2" fill="none" stroke={MAP_COLOR.fireEdge} strokeWidth="2.5" />
      </svg>
    ),
  },
  {
    key: "bd-fs-out",
    label: "Burned out: dark hatch (sim)",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <defs>
          <pattern id="lc-lg-bd-scar" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="5" stroke={BOARD_COLOR.scarEdge} strokeWidth="2" />
          </pattern>
        </defs>
        <rect x="1" y="1" width="18" height="12" rx="2" fill={BOARD_COLOR.scar} fillOpacity="0.4" />
        <rect x="1" y="1" width="18" height="12" rx="2" fill="url(#lc-lg-bd-scar)" fillOpacity="0.75" stroke={BOARD_COLOR.scarEdge} strokeWidth="1" />
      </svg>
    ),
  },
  {
    key: "bd-fs-ext",
    label: "Put out by crews: blue-grey, dashed outline (sim)",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <rect x="1" y="1" width="18" height="12" rx="2" fill={BOARD_COLOR.extinguished} fillOpacity="0.4" stroke={BOARD_COLOR.extinguishedEdge} strokeWidth="2" strokeDasharray="3 2" />
      </svg>
    ),
  },
  {
    key: "bd-fs-contained",
    label: "Contained fire, thin dashed edge (sim)",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <rect x="1" y="1" width="18" height="12" rx="2" fill="none" stroke={MAP_COLOR.fireEdge} strokeWidth="1.5" strokeDasharray="3 2" />
      </svg>
    ),
  },
  {
    key: "bd-crews",
    label: "Firefighters at work, with a trail of the edge just worked (sim)",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <line x1="1" y1="9" x2="13" y2="7" stroke={MAP_COLOR.responder} strokeOpacity="0.55" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="9" cy="7.5" r="2.2" fill={MAP_COLOR.responder} stroke={BOARD_COLOR.crewEdge} strokeWidth="1" />
        <circle cx="15" cy="6.5" r="2.8" fill={MAP_COLOR.responder} stroke={BOARD_COLOR.crewEdge} strokeWidth="1" />
      </svg>
    ),
  },
];

/** The simulated board's marks (drawn by demo/boardMapLayers.ts). All simulation output. */
const BOARD_ROWS: { key: string; label: string; swatch: ReactNode }[] = [
  ...FIRE_STATE_ROWS,
  { key: "bd-leave", label: "Board zone: leave now (sim)", swatch: zoneSw(LEVEL_COLOR.evacuate_now, 0.15) },
  { key: "bd-risk", label: "Board zone: at risk (sim)", swatch: zoneSw(LEVEL_COLOR.be_ready, 0.15) },
  { key: "bd-overrun", label: "Board zone: overrun (sim)", swatch: zoneSw(BOARD_COLOR.overrun, 0.3, 3) },
  { key: "bd-clear", label: "Board zone: all clear, order lifted (sim)", swatch: zoneSw(BOARD_COLOR.allClear, 0, 1) },
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
    key: "bd-returning",
    label: "Unit returning or moving up to cover a station; unit lines follow roads (sim)",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <line x1="1" y1="7" x2="19" y2="7" stroke={MAP_COLOR.responder} strokeOpacity="0.6" strokeWidth="1.5" strokeDasharray="0.5 2" />
        <circle cx="14" cy="7" r="4.5" fill={MAP_COLOR.responder} fillOpacity="0.55" stroke="#fff" strokeWidth="1" />
      </svg>
    ),
  },
  {
    key: "bd-fireline",
    label: "Fire line ahead of a fire: built solid, planned dashed (sim)",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <line x1="1" y1="7" x2="10" y2="7" stroke={BOARD_COLOR.fireLine} strokeOpacity="0.85" strokeWidth="2.5" />
        <line x1="10" y1="7" x2="19" y2="7" stroke={BOARD_COLOR.fireLine} strokeOpacity="0.7" strokeWidth="1.5" strokeDasharray="3 2" />
      </svg>
    ),
  },
  {
    key: "bd-evac",
    label: "Evacuating vehicles on their route (sim)",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <line x1="1" y1="7" x2="19" y2="7" stroke={MAP_COLOR.route} strokeOpacity="0.55" strokeWidth="1.8" strokeDasharray="3 2" />
        <circle cx="7" cy="7" r="2.5" fill={BOARD_COLOR.evacuee} fillOpacity="0.8" stroke="#fff" strokeWidth="0.8" />
        <circle cx="14" cy="7" r="2.5" fill={BOARD_COLOR.evacuee} fillOpacity="0.8" stroke="#fff" strokeWidth="0.8" />
      </svg>
    ),
  },
  {
    key: "bd-no-truck",
    label: "Road the unit's truck can't use (rules R01-R12)",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <line x1="1" y1="7" x2="19" y2="7" stroke="#fff" strokeWidth="5" />
        <line x1="1" y1="7" x2="19" y2="7" stroke={BOARD_COLOR.noTruck} strokeWidth="2.5" strokeDasharray="2.5 3" />
      </svg>
    ),
  },
  {
    key: "bd-station",
    label: "Fire station (sim)",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <circle cx="10" cy="7" r="4" fill="#fff" stroke={MAP_COLOR.ink} strokeWidth="3" />
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
    // Controller drill road closures (live/roadClosureLayer.ts): dark line, white X marks.
    key: "closed-drill",
    label: "Closed road (drill, controller): no unit or evacuee uses it",
    swatch: (
      <svg viewBox="0 0 20 14" aria-hidden="true">
        <line x1="2" y1="7" x2="18" y2="7" stroke={MAP_COLOR.casing} strokeWidth="9" strokeLinecap="round" />
        <line x1="2" y1="7" x2="18" y2="7" stroke={MAP_COLOR.ink} strokeWidth="6" strokeLinecap="round" />
        <path d="M7.5 4.5 L12.5 9.5 M12.5 4.5 L7.5 9.5" stroke={MAP_COLOR.casing} strokeWidth="1.6" strokeLinecap="round" />
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

export default function MapLegend({
  record = true,
  board = false,
  houses = false,
}: {
  record?: boolean;
  board?: boolean;
  /** The Houses layer is on: add its status rows. */
  houses?: boolean;
}) {
  return (
    <details className="lc-legend" open>
      <summary>Legend</summary>
      <ul>
        {ROWS.filter((r) => record || r.key !== "ground").map((r) => (
          <li key={r.key}>
            <span className="lc-legend-sw">{r.swatch}</span>
            {r.label}
          </li>
        ))}
        {houses && (
          <>
            <li className="lc-legend-group">
              Houses <EvidenceTag kind="simulated" />
            </li>
            {HOUSEHOLD_STATUSES.map((s) => (
              <li key={`house-${s}`} title={HOUSEHOLD_DETAIL[s]}>
                <span className="lc-legend-sw">
                  <HouseSwatch status={s} />
                </span>
                {HOUSEHOLD_LABEL[s]}
              </li>
            ))}
          </>
        )}
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
