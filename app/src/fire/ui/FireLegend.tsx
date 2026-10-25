import { useId, useState, type ReactNode } from "react";
import { BurnedGlyph, FireEdgeGlyph, StationBadgeGlyph, WindGlyph } from "../../diorama/ui/glyphs";
import { Button } from "../../ui";
import { ARRIVAL_COLORS, CURRENT_PERIMETER_COLOR, FUEL_COLORS } from "../fuelPalette";

const SIZE = { width: 24, height: 16, viewBox: "0 0 24 16" } as const;

function FlameGlyph() {
  return (
    <svg {...SIZE} aria-hidden="true">
      <path
        d="M12 14.5c-3.6 0-5.4-2.4-4.6-5.2.5-1.6 1.8-2.6 2.2-4.6 1.6 1 2.2 2.2 2.4 3.4.6-.6.9-1.5.8-2.6 2.2 1.8 3.4 3.6 3.2 5.2-.2 2.2-1.8 3.8-4 3.8z"
        fill={"var(--ct-ember)"}
        stroke={"var(--ct-fire)"}
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IgnitionGlyph() {
  return (
    <svg {...SIZE} aria-hidden="true">
      <circle
        cx="12"
        cy="8"
        r="5.5"
        fill="var(--ct-surface-raised)"
        stroke={"var(--ct-ink)"}
        strokeWidth="1.4"
      />
      <circle cx="12" cy="8" r="2.4" fill={"var(--ct-fire)"} />
    </svg>
  );
}

function ArrivalGradientGlyph() {
  return (
    <svg {...SIZE} aria-hidden="true">
      <defs>
        <linearGradient id="fr-arrival-gradient" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor={ARRIVAL_COLORS.earliest} />
          <stop offset="0.5" stopColor={ARRIVAL_COLORS.middle} />
          <stop offset="1" stopColor={ARRIVAL_COLORS.latest} />
        </linearGradient>
      </defs>
      <rect x="1" y="3" width="22" height="10" rx="2" fill="url(#fr-arrival-gradient)" />
    </svg>
  );
}

function CurrentPerimeterGlyph() {
  return (
    <svg {...SIZE} aria-hidden="true">
      <rect x="1" y="3" width="22" height="10" rx="2" fill="#2b3a37" />
      <path
        d="M3 8c3-4 6 4 9 0s6 4 9 0"
        fill="none"
        stroke={CURRENT_PERIMETER_COLOR}
        strokeWidth="2.4"
      />
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
  view: "diorama" | "satellite";
  windTowardDegrees: number;
  showFuel: boolean;
  defaultOpen: boolean;
};

/** Compact collapsible legend. Every entry pairs a colour with a shape or a letter code. */
export default function FireLegend({
  view,
  windTowardDegrees,
  showFuel,
  defaultOpen,
}: FireLegendProps) {
  const [open, setOpen] = useState(defaultOpen);
  const listId = useId();

  const items: { glyph: ReactNode; label: string }[] =
    view === "satellite"
      ? [
          {
            glyph: <ArrivalGradientGlyph />,
            label: "Burned area by arrival: dark red (earliest) to yellow (latest)",
          },
          { glyph: <CurrentPerimeterGlyph />, label: "Current fire perimeter (pale line)" },
        ]
      : [
          { glyph: <FlameGlyph />, label: "Burning (active front glows)" },
          { glyph: <FireEdgeGlyph />, label: "Fire front (current perimeter)" },
          { glyph: <BurnedGlyph />, label: "Burned (charred ground)" },
          { glyph: <StationBadgeGlyph />, label: "Fire station" },
        ];
  items.push(
    { glyph: <IgnitionGlyph />, label: "Ignition point" },
    {
      glyph: <WindGlyph bearing={windTowardDegrees} />,
      label: `Wind arrow, pointing toward ${Math.round(windTowardDegrees)}°`,
    },
  );
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
      <Button
        variant="ghost"
        block
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
      </Button>
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
