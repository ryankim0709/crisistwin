import { Legend, type LegendItem } from "../ui";
import { COLORS } from "./dispatchLayers";
import "./dispatchMap.css";

// Colours come from the map paint palette so the key always matches the layers.
const ITEMS: LegendItem[] = [
  { label: "Zone ordered to leave", color: COLORS.ordered, shape: "dashed" },
  { label: "Zone cleared", color: COLORS.cleared, shape: "square" },
  { label: "Fire reached people", color: COLORS.overrunLine, shape: "square" },
  { label: "Route blocked", color: COLORS.blocked, shape: "dashed" },
  { label: "Evacuation route", color: COLORS.route, shape: "line" },
  { label: "Cars on the road", color: COLORS.vehicle, shape: "dot" },
  { label: "Burned road", color: COLORS.burned, shape: "line" },
  { label: "Closed road", color: COLORS.closed, shape: "dashed" },
  { label: "Engine heading out", color: COLORS.unitPath, shape: "dashed" },
];

const MARKERS: { glyph: string; text: string }[] = [
  { glyph: "⇥", text: "X13 exit" },
  { glyph: "▲", text: "S07 fire station" },
  { glyph: "E", text: "Fire engine" },
];

export default function DispatchLegend() {
  return (
    <div className="studio-map__legend-group studio-map__legend-group--dispatch">
      <h3>Dispatch</h3>
      <Legend label="Dispatch map layers" items={ITEMS} />
      <ul className="dsp-legend__markers" aria-label="Dispatch markers">
        {MARKERS.map((item) => (
          <li key={item.text}>
            <span className="dsp-legend__tag" aria-hidden="true">
              {item.glyph}
            </span>
            {item.text}
          </li>
        ))}
      </ul>
      <p className="dsp-legend__note">
        Roads &amp; stations © OpenStreetMap. Zones and cars are synthetic.
      </p>
    </div>
  );
}
