import { COLORS } from "./mapLayers";
import { compassPoint } from "./timeline";

/** Compact always-on key: icon plus text for each mark, so colour never carries meaning alone. */
export default function MapLegend({
  windFromDeg,
  open,
  onToggle,
}: {
  windFromDeg: number | null;
  open: boolean;
  onToggle: () => void;
}) {
  if (!open) {
    return (
      <button type="button" className="rp-key-btn" aria-expanded={false} onClick={onToggle}>
        Key
      </button>
    );
  }
  return (
    <div className="rp-maplegend" aria-label="Map key">
      <button type="button" className="rp-key-close" aria-expanded={true} onClick={onToggle}>
        Hide key
      </button>
      <ul>
        <li>
          <svg viewBox="0 0 28 14" aria-hidden="true">
            <rect x="1" y="1" width="26" height="12" rx="2" fill={COLORS.char} stroke={COLORS.fireBand} strokeWidth="2.5" />
            <rect x="18" y="1" width="9" height="12" fill={COLORS.fireBand} />
          </svg>
          Fire (model)
        </li>
        <li>
          <svg viewBox="0 0 28 14" aria-hidden="true">
            <rect x="1.5" y="1.5" width="25" height="11" rx="2" fill="none" stroke={COLORS.satellite} strokeWidth="1.6" strokeDasharray="3 2" />
          </svg>
          Satellite fire perimeter
        </li>
        <li>
          <svg viewBox="0 0 28 14" aria-hidden="true">
            <line x1="1" y1="7" x2="27" y2="7" stroke={COLORS.free} strokeWidth="2" opacity="0.5" />
            <circle cx="7" cy="7" r="2.6" fill={COLORS.particle} />
            <circle cx="15" cy="7" r="2.6" fill={COLORS.particle} />
            <circle cx="23" cy="7" r="2.6" fill={COLORS.particle} />
          </svg>
          Vehicles evacuating
        </li>
        <li>
          <svg viewBox="0 0 28 14" aria-hidden="true">
            <line x1="1" y1="7" x2="27" y2="7" stroke={COLORS.jam} strokeWidth="5" strokeLinecap="round" />
          </svg>
          Jammed road (thick)
        </li>
        <li>
          <svg viewBox="0 0 28 14" aria-hidden="true">
            <line x1="1" y1="7" x2="27" y2="7" stroke={COLORS.closed} strokeWidth="2.5" strokeDasharray="3 3" />
          </svg>
          Closed road (dashed)
        </li>
      </ul>
      {windFromDeg !== null && (
        <p className="rp-wind">
          <svg viewBox="0 0 20 20" aria-hidden="true" style={{ transform: `rotate(${windFromDeg}deg)` }}>
            <path d="M10 2 L10 17 M5 12 L10 17 L15 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          Model wind from {compassPoint(windFromDeg)} ({windFromDeg}°)
        </p>
      )}
    </div>
  );
}
