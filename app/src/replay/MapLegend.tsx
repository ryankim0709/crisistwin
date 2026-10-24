import { Button } from "../ui";
import { COLORS, PEOPLE_RAMP } from "./mapLayers";
import { MOBILITY_COLORS } from "./mobility";
import type { EvidenceClass } from "./types";
import { EVIDENCE_LABEL, compassPoint } from "./timeline";

/** Compact always-on key: icon plus text for each mark, so colour never carries meaning alone. */
export default function MapLegend({
  windFromDeg,
  fireObsSource = null,
  showFireObs = false,
  showDestinations = false,
  peopleSource = null,
  mobilityEvidence = null,
  open,
  onToggle,
}: {
  windFromDeg: number | null;
  /** e.g. "NIST" when the bundle has fire observation points; null hides that row. */
  fireObsSource?: string | null;
  /** Extra rows only while those optional layers are switched on. */
  showFireObs?: boolean;
  showDestinations?: boolean;
  /** Source text for the people-at-home ramp (e.g. "Census 2018 ACS"); null hides the row. */
  peopleSource?: string | null;
  /** Evidence class of the device-movement layer while it is shown; null hides the row. */
  mobilityEvidence?: EvidenceClass | null;
  open: boolean;
  onToggle: () => void;
}) {
  if (!open) {
    return (
      <Button
        variant="secondary"
        size="sm"
        className="rp-key-btn"
        aria-expanded={false}
        onClick={onToggle}
      >
        Key
      </Button>
    );
  }
  return (
    <div className="rp-maplegend" aria-label="Map key">
      <Button
        variant="ghost"
        size="sm"
        className="rp-key-close"
        aria-expanded={true}
        onClick={onToggle}
      >
        Hide key
      </Button>
      <ul>
        <li>
          <svg viewBox="0 0 28 14" aria-hidden="true">
            <rect
              x="1"
              y="1"
              width="26"
              height="12"
              rx="2"
              fill={COLORS.char}
              stroke={COLORS.fireBand}
              strokeWidth="2.5"
            />
          </svg>
          Fire (model)
        </li>
        <li>
          <svg viewBox="0 0 28 14" aria-hidden="true">
            <rect
              x="1.5"
              y="1.5"
              width="25"
              height="11"
              rx="2"
              fill="none"
              stroke={COLORS.satellite}
              strokeWidth="1.6"
              strokeDasharray="3 2"
            />
          </svg>
          Satellite fire perimeter
        </li>
        <li>
          <svg viewBox="0 0 28 14" aria-hidden="true">
            <line x1="1" y1="5" x2="27" y2="5" stroke={COLORS.free} strokeWidth="2" />
            <line x1="1" y1="11" x2="27" y2="11" stroke={COLORS.jam} strokeWidth="4.5" />
          </svg>
          Traffic (thick, darker = jammed)
        </li>
        <li>
          <svg viewBox="0 0 28 14" aria-hidden="true">
            <circle cx="9" cy="7" r="3" fill={COLORS.particle} stroke={COLORS.particleGlow} strokeWidth="0.8" />
            <circle
              cx="19"
              cy="7"
              r="3"
              fill={COLORS.particleStopped}
              stroke={COLORS.markerCore}
              strokeWidth="1.4"
            />
          </svg>
          Moving · stopped vehicles
        </li>
        <li>
          <svg viewBox="0 0 28 14" aria-hidden="true">
            <line
              x1="1"
              y1="7"
              x2="27"
              y2="7"
              stroke={COLORS.closed}
              strokeWidth="2.5"
              strokeDasharray="3 3"
            />
          </svg>
          Closed road
        </li>
        {peopleSource && (
          <li>
            <svg viewBox="0 0 28 14" aria-hidden="true">
              {PEOPLE_RAMP.slice(1).map(([, color], i) => (
                <rect key={color} x={1 + i * 6.5} y="2" width="6.5" height="10" fill={color} />
              ))}
            </svg>
            Households at home per km² (0–{PEOPLE_RAMP[PEOPLE_RAMP.length - 1][0]}+), {peopleSource}
          </li>
        )}
        {mobilityEvidence && (
          <li>
            <svg viewBox="0 0 28 14" aria-hidden="true">
              <circle cx="6" cy="7" r="3" fill={MOBILITY_COLORS.below} />
              <circle cx="14" cy="7" r="3.5" fill={MOBILITY_COLORS.near} />
              <circle cx="23" cy="7" r="4" fill={MOBILITY_COLORS.above} />
            </svg>
            Movement (device data, {EVIDENCE_LABEL[mobilityEvidence]}): darker = more visits than
            usual
          </li>
        )}
        {showFireObs && fireObsSource && (
          <li>
            <svg viewBox="0 0 28 14" aria-hidden="true">
              <circle cx="9" cy="7" r="3" fill="none" stroke={COLORS.fireObs} strokeWidth="1.2" />
              <circle cx="19" cy="7" r="4" fill="none" stroke={COLORS.fireObs} strokeWidth="1.2" />
            </svg>
            Fire observed ({fireObsSource})
          </li>
        )}
        {showDestinations && (
          <li>
            <svg viewBox="0 0 28 14" aria-hidden="true">
              <circle
                cx="8"
                cy="7"
                r="4"
                fill={COLORS.markerCore}
                stroke={COLORS.destination}
                strokeWidth="2.2"
              />
              <circle
                cx="20"
                cy="7"
                r="4.6"
                fill={COLORS.refuge}
                stroke={COLORS.refugeRing}
                strokeWidth="1.6"
              />
            </svg>
            Exit (ring) · refuge (solid)
          </li>
        )}
      </ul>
      {windFromDeg !== null && (
        <p className="rp-wind">
          <svg
            viewBox="0 0 20 20"
            aria-hidden="true"
            style={{ transform: `rotate(${windFromDeg}deg)` }}
          >
            <path
              d="M10 2 L10 17 M5 12 L10 17 L15 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          Model wind from {compassPoint(windFromDeg)} ({windFromDeg}°)
        </p>
      )}
    </div>
  );
}
