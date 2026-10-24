import { useId, useState, type ReactNode } from "react";
import type { World } from "../types";
import { bearingDeg, compassName } from "./format";
import {
  BottleneckGlyph,
  BurnedGlyph,
  CarGlyph,
  ClosedRoadGlyph,
  FireEdgeGlyph,
  HeldLineGlyph,
  ShelterGlyph,
  StationGlyph,
  TruckGlyph,
  WindGlyph,
} from "./glyphs";

type LegendProps = { world: World; defaultOpen: boolean };

export default function Legend({ world, defaultOpen }: LegendProps) {
  const [open, setOpen] = useState(defaultOpen);
  const listId = useId();
  const bearing = bearingDeg(world.wind.toward);

  const items: { glyph: ReactNode; label: string }[] = [
    { glyph: <CarGlyph />, label: "Resident vehicle" },
    { glyph: <TruckGlyph />, label: "Fire engine" },
    { glyph: <FireEdgeGlyph />, label: "Active fire edge" },
    { glyph: <BurnedGlyph />, label: "Burned area" },
    { glyph: <HeldLineGlyph />, label: "Section held by crews" },
    { glyph: <ShelterGlyph />, label: world.shelter.label },
    { glyph: <StationGlyph />, label: world.station.label },
    { glyph: <BottleneckGlyph />, label: "Single-lane bridge queue" },
    { glyph: <ClosedRoadGlyph />, label: "Closed road" },
    {
      glyph: <WindGlyph bearing={bearing} />,
      label: `Wind ${world.wind.label}, blowing ${compassName(bearing)}`,
    },
  ];

  return (
    <section className="dio-legend dio-panel" aria-label="Map legend" data-open={open}>
      <button
        type="button"
        className="dio-legend-toggle"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
      >
        <span>Legend</span>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d={open ? "M2.5 4.5 6 8l3.5-3.5" : "M2.5 7.5 6 4l3.5 3.5"} fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      <ul id={listId} className="dio-legend-list" hidden={!open}>
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
