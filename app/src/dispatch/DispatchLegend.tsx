import "./dispatchMap.css";

const ITEMS: { key: string; text: string }[] = [
  { key: "ordered", text: "Zone ordered to leave" },
  { key: "cleared", text: "Zone cleared" },
  { key: "overrun", text: "Fire reached people" },
  { key: "blocked", text: "Route blocked" },
  { key: "route", text: "Evacuation route" },
  { key: "vehicle", text: "Cars on the road" },
  { key: "burned", text: "Burned road" },
  { key: "unitpath", text: "Engine heading out" },
];

export default function DispatchLegend() {
  return (
    <div className="studio-map__legend-group studio-map__legend-group--dispatch dispatch-legend">
      <h3>Dispatch</h3>
      <ul>
        {ITEMS.map((item) => (
          <li key={item.key}>
            <span
              className={`dispatch-legend__key dispatch-legend__key--${item.key}`}
              aria-hidden="true"
            />
            {item.text}
          </li>
        ))}
        <li>
          <span className="dispatch-legend__tag" aria-hidden="true">
            ⇥
          </span>
          X13 exit
        </li>
        <li>
          <span className="dispatch-legend__tag" aria-hidden="true">
            ▲
          </span>
          S07 fire station
        </li>
        <li>
          <span className="dispatch-legend__tag" aria-hidden="true">
            E
          </span>
          Fire engine
        </li>
      </ul>
      <p className="dispatch-legend__note">
        Roads &amp; stations © OpenStreetMap. Zones and cars are synthetic.
      </p>
    </div>
  );
}
