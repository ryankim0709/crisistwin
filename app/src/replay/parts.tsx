import { EVIDENCE_LABEL, type EventCategory } from "./timeline";
import type { EvidenceClass } from "./types";

/** Evidence class as text plus a per-class border pattern (never color alone). */
export function EvidenceChip({ value }: { value: EvidenceClass }) {
  return (
    <span className={`rp-chip rp-chip--${value}`} title={`Evidence class: ${value}`}>
      {EVIDENCE_LABEL[value]}
    </span>
  );
}

export const EVENT_CATEGORY_LABEL: Record<EventCategory, string> = {
  fire: "Fire / perimeter",
  order: "Evacuation order",
  warning: "Alert / warning",
  closure: "Road closure",
  other: "Other",
};

/** Distinct shape per event category: triangle, square, diamond, cross, circle. */
export function EventGlyph({ category, size = 12 }: { category: EventCategory; size?: number }) {
  const shape = (() => {
    switch (category) {
      case "fire":
        return <polygon points="6,1 11,11 1,11" />;
      case "order":
        return <rect x="1.5" y="1.5" width="9" height="9" />;
      case "warning":
        return <polygon points="6,0.5 11.5,6 6,11.5 0.5,6" />;
      case "closure":
        return <path d="M2 2 L10 10 M10 2 L2 10" className="rp-glyph-stroke" />;
      default:
        return <circle cx="6" cy="6" r="4.5" />;
    }
  })();
  return (
    <svg
      className={`rp-glyph rp-glyph--${category}`}
      width={size}
      height={size}
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      {shape}
    </svg>
  );
}

export function Sparkline({
  points,
  startMs,
  endMs,
  cursorMs,
}: {
  points: { atMs: number; value: number }[];
  startMs: number;
  endMs: number;
  cursorMs: number;
}) {
  const width = 100;
  const height = 26;
  if (points.length === 0) return null;
  const span = Math.max(1, endMs - startMs);
  const max = Math.max(1, ...points.map((p) => p.value));
  const xy = points.map((p) => {
    const x = ((p.atMs - startMs) / span) * width;
    const y = height - 2 - (p.value / max) * (height - 4);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const cursorX = Math.min(width, Math.max(0, ((cursorMs - startMs) / span) * width));
  const firstX = ((points[0].atMs - startMs) / span) * width;
  const lastX = ((points[points.length - 1].atMs - startMs) / span) * width;
  return (
    <svg className="rp-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <polygon
        className="rp-spark-area"
        points={`${firstX},${height} ${xy.join(" ")} ${lastX},${height}`}
      />
      <polyline className="rp-spark-line" points={xy.join(" ")} />
      <rect className="rp-spark-future" x={cursorX} y="0" width={width - cursorX} height={height} />
      <line className="rp-spark-cursor" x1={cursorX} x2={cursorX} y1="0" y2={height} />
    </svg>
  );
}
