import { useId, useState, type ReactNode } from "react";
import { BurnedGlyph, DIORAMA_COLORS, FireEdgeGlyph, WindGlyph } from "../../diorama/ui/glyphs";
import { FUEL_COLORS } from "../fuelPalette";

const SIZE = { width: 24, height: 16, viewBox: "0 0 24 16" } as const;

function FlameGlyph() {
  return (
    <svg {...SIZE} aria-hidden="true">
      <path
        d="M12 14.5c-3.6 0-5.4-2.4-4.6-5.2.5-1.6 1.8-2.6 2.2-4.6 1.6 1 2.2 2.2 2.4 3.4.6-.6.9-1.5.8-2.6 2.2 1.8 3.4 3.6 3.2 5.2-.2 2.2-1.8 3.8-4 3.8z"
        fill={DIORAMA_COLORS.fireAmber}
        stroke={DIORAMA_COLORS.fireCoral}
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IgnitionGlyph() {
  return (
    <svg {...SIZE} aria-hidden="true">
      <circle cx="12" cy="8" r="5.5" fill="#fff" stroke={DIORAMA_COLORS.ink} strokeWidth="1.4" />
      <circle cx="12" cy="8" r="2.4" fill={DIORAMA_COLORS.fireCoral} />
    </svg>
  );
}

function FuelSwatch({ color, code }: { color: string; code: string }) {
  return (
    <span className="fr-fuel-swatch" style={{ background: color }} aria-hidden="true">
      {code}
    </span>
  );
}

/** Two-letter family code from "Grass (GR)", or "NB" for non-burnable ground. */
function familyCode(label: string): string {
  return /\(([A-Z]{2})\)/.exec(label)?.[1] ?? "NB";
}

type FireLegendProps = {
  windTowardDegrees: number;
  showFuel: boolean;
  defaultOpen: boolean;
};

/** Compact collapsible legend. Every entry pairs a colour with a shape or a letter code. */
export default function FireLegend({ windTowardDegrees, showFuel, defaultOpen }: FireLegendProps) {
  const [open, setOpen] = useState(defaultOpen);
  const listId = useId();

  const items: { glyph: ReactNode; label: string }[] = [
    { glyph: <FlameGlyph />, label: "Burning (active front glows)" },
    { glyph: <FireEdgeGlyph />, label: "Fire front (current perimeter)" },
    { glyph: <BurnedGlyph />, label: "Burned (charred ground)" },
    { glyph: <IgnitionGlyph />, label: "Ignition point" },
    {
      glyph: <WindGlyph bearing={windTowardDegrees} />,
      label: `Wind arrow, pointing toward ${Math.round(windTowardDegrees)}°`,
    },
  ];
  if (showFuel) {
    for (const entry of FUEL_COLORS) {
      items.push({
        glyph: <FuelSwatch color={entry.color} code={familyCode(entry.label)} />,
        label: entry.label,
      });
    }
  }

  return (
    <section className="fr-legend fr-panel" aria-label="Map legend" data-open={open}>
      <button
        type="button"
        className="fr-legend-toggle"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
      >
        <span>Legend</span>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path
            d={open ? "M2.5 4.5 6 8l3.5-3.5" : "M2.5 7.5 6 4l3.5 3.5"}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </svg>
      </button>
      <ul id={listId} className="fr-legend-list" hidden={!open}>
        {items.map((item) => (
          <li key={item.label}>
            {item.glyph}
            <span>{item.label}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
