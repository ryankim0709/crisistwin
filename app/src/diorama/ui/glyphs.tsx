import { useId } from "react";

/**
 * Small inline legend glyphs. Each pairs a colour with a distinct shape so the legend never
 * relies on colour alone. Colours reference the shared `--ct-*` hazard tokens where one exists.
 */
const SIZE = { width: 24, height: 16, viewBox: "0 0 24 16" } as const;

const DIORAMA_COLORS = {
  fireAmber: "var(--ct-ember)",
  fireCoral: "var(--ct-fire)",
  burned: "var(--ct-burned)",
  civilian: "var(--ct-water)",
  engine: "#d6413a",
  engineLight: "#3d7bf2",
  shelter: "var(--ct-brand)",
  sage: "var(--ct-vegetation)",
  ink: "var(--ct-ink)",
  held: "#6f8fd6",
} as const;

export function CarGlyph() {
  return (
    <svg {...SIZE} aria-hidden="true">
      <path
        d="M4 10.5 6 6.5h8.5l3 4H20v2.5H4z"
        fill={DIORAMA_COLORS.civilian}
        stroke={DIORAMA_COLORS.ink}
        strokeWidth="0.8"
      />
      <circle cx="8" cy="13" r="1.6" fill={DIORAMA_COLORS.ink} />
      <circle cx="16.5" cy="13" r="1.6" fill={DIORAMA_COLORS.ink} />
    </svg>
  );
}

export function TruckGlyph() {
  return (
    <svg {...SIZE} aria-hidden="true">
      <rect
        x="2"
        y="5.5"
        width="13"
        height="7"
        rx="0.8"
        fill={DIORAMA_COLORS.engine}
        stroke={DIORAMA_COLORS.ink}
        strokeWidth="0.8"
      />
      <path
        d="M15 7.5h3.5l3 3V12.5H15z"
        fill={DIORAMA_COLORS.engine}
        stroke={DIORAMA_COLORS.ink}
        strokeWidth="0.8"
      />
      <rect x="15.5" y="4" width="2.6" height="2" rx="0.6" fill={DIORAMA_COLORS.engineLight} />
      <path d="M3.5 7.5h10" stroke="#fff" strokeWidth="0.8" />
      <circle cx="6" cy="13" r="1.6" fill={DIORAMA_COLORS.ink} />
      <circle cx="18" cy="13" r="1.6" fill={DIORAMA_COLORS.ink} />
    </svg>
  );
}

export function FireEdgeGlyph() {
  return (
    <svg {...SIZE} aria-hidden="true">
      <path
        d="M1 12.5c3-2 5 1 8-1s5 1 8-1 4 0 6-1"
        fill="none"
        stroke={DIORAMA_COLORS.fireCoral}
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path
        d="M12 9.5c-2.2-1.6-1.6-4 .4-6.5.2 1.8 2.6 2.6 2.4 4.6-.1 1.2-1.4 2.2-2.8 1.9z"
        fill={DIORAMA_COLORS.fireAmber}
        stroke={DIORAMA_COLORS.fireCoral}
        strokeWidth="0.7"
      />
    </svg>
  );
}

export function BurnedGlyph() {
  const id = useId();
  return (
    <svg {...SIZE} aria-hidden="true">
      <defs>
        <pattern
          id={id}
          width="4"
          height="4"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width="4" height="4" fill="#6b625a" />
          <path d="M0 0v4" stroke={DIORAMA_COLORS.burned} strokeWidth="2" />
        </pattern>
      </defs>
      <rect
        x="2"
        y="3"
        width="20"
        height="10"
        rx="2"
        fill={`url(#${id})`}
        stroke={DIORAMA_COLORS.burned}
        strokeWidth="0.8"
      />
    </svg>
  );
}

export function ShelterGlyph() {
  return (
    <svg {...SIZE} aria-hidden="true">
      <path
        d="M4 8 12 2.5 20 8"
        fill="none"
        stroke={DIORAMA_COLORS.shelter}
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <rect x="6" y="7.5" width="12" height="7" fill={DIORAMA_COLORS.shelter} />
      <path d="M12 9v4M10 11h4" stroke="#fff" strokeWidth="1.4" />
    </svg>
  );
}

export function StationGlyph() {
  return (
    <svg {...SIZE} aria-hidden="true">
      <rect
        x="3"
        y="5"
        width="18"
        height="9.5"
        fill="#efe4d6"
        stroke={DIORAMA_COLORS.engine}
        strokeWidth="1.2"
      />
      <path d="M3 5h18l-2-2.5H5z" fill={DIORAMA_COLORS.engine} />
      <rect x="6" y="8.5" width="5" height="6" fill={DIORAMA_COLORS.engine} />
      <rect x="13" y="8.5" width="5" height="6" fill={DIORAMA_COLORS.engine} />
    </svg>
  );
}

export function BottleneckGlyph() {
  return (
    <svg {...SIZE} aria-hidden="true">
      <path
        d="M1 3.5h7l4 3h0l4-3h7M1 12.5h7l4-3 4 3h7"
        fill="none"
        stroke={DIORAMA_COLORS.ink}
        strokeWidth="1"
      />
      <path
        d="M5 6.5 8 8l-3 1.5M10 6.5 13 8l-3 1.5"
        fill="none"
        stroke={DIORAMA_COLORS.fireAmber}
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ClosedRoadGlyph() {
  return (
    <svg {...SIZE} aria-hidden="true">
      <rect
        x="2"
        y="5"
        width="20"
        height="5"
        rx="1"
        fill="#fff"
        stroke={DIORAMA_COLORS.ink}
        strokeWidth="0.8"
      />
      <path
        d="M5 5 2.5 10M10 5l-2.5 5M15 5l-2.5 5M20 5l-2.5 5"
        stroke={DIORAMA_COLORS.engine}
        strokeWidth="2"
      />
      <path d="M5 10v4.5M19 10v4.5" stroke={DIORAMA_COLORS.ink} strokeWidth="1.2" />
    </svg>
  );
}

export function HeldLineGlyph() {
  return (
    <svg {...SIZE} aria-hidden="true">
      <path d="M2 8h20" stroke={DIORAMA_COLORS.held} strokeWidth="2.4" strokeDasharray="3 2" />
      <path d="M12 3v10" stroke={DIORAMA_COLORS.ink} strokeWidth="1" />
    </svg>
  );
}

/** Arrow pointing toward `bearing` degrees clockwise from the top of the glyph (map north). */
export function WindGlyph({ bearing }: { bearing: number }) {
  return (
    <svg {...SIZE} aria-hidden="true">
      <g transform={`rotate(${bearing} 12 8)`}>
        <path
          d="M12 14.5V2.5M8 6.5l4-4 4 4"
          fill="none"
          stroke={DIORAMA_COLORS.ink}
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}

/** The 3D fire-station marker's badge: a round red disc with a white firehouse. */
export function StationBadgeGlyph() {
  return (
    <svg {...SIZE} aria-hidden="true">
      <circle cx="12" cy="8" r="7" fill="#c8352a" stroke="#fff" strokeWidth="1.5" />
      <path d="M6.5 8.5 12 4l5.5 4.5V12h-11z" fill="#fff" />
      <rect x="10" y="9" width="4" height="3" fill="#c8352a" />
    </svg>
  );
}
