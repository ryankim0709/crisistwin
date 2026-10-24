import "./dispatchMap.css";

const ITEMS: { key: string; text: string }[] = [
  { key: "none", text: "No order (thin outline)" },
  { key: "ordered", text: "Ordered (amber, dashed)" },
  { key: "cleared", text: "Cleared (green, solid)" },
  { key: "overrun", text: "Overrun (dark red, thick)" },
  { key: "blocked", text: "Route blocked (red dashes)" },
  { key: "fire", text: "Fire contact (orange halo)" },
  { key: "route", text: "Evacuation route" },
  { key: "vehicle", text: "Vehicles (size = count)" },
  { key: "stuck", text: "Vehicles stuck (magenta)" },
  { key: "burned", text: "Burned road (solid red)" },
  { key: "closed", text: "Closed: fire within 10 min" },
  { key: "unitpath", text: "Fire engine path (blue dashes)" },
];

export default function DispatchLegend() {
  return (
    <div className="studio-map__legend-group studio-map__legend-group--dispatch dispatch-legend">
      <h3>Dispatch (simulated)</h3>
      <ul>
        {ITEMS.map((item) => (
          <li key={item.key}>
            <span className={`dispatch-legend__key dispatch-legend__key--${item.key}`} aria-hidden="true" />
            {item.text}
          </li>
        ))}
        <li>
          <span className="dispatch-legend__tag" aria-hidden="true">⇥</span>X13 exit
        </li>
        <li>
          <span className="dispatch-legend__tag" aria-hidden="true">▲</span>S07 fire station
        </li>
        <li>
          <span className="dispatch-legend__tag" aria-hidden="true">E</span>Engine: grey idle/returning, blue en route, ringed on scene, red ! stranded
        </li>
      </ul>
      <p className="dispatch-legend__note">
        Roads &amp; stations: © OpenStreetMap contributors. Zones &amp; vehicles are synthetic.
      </p>
    </div>
  );
}
