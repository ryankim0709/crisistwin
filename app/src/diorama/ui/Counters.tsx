import { memo } from "react";
import { Metric, Panel } from "../../ui";
import type { Counters as CounterValues } from "../types";
import { formatCount } from "./format";

type CountersProps = { counters: CounterValues };

/** Compact simulated counters, read only from the current snapshot. */
function Counters({ counters }: CountersProps) {
  const items = [
    {
      key: "sheltered",
      label: "Residents sheltered",
      value: formatCount(counters.sheltered),
      total: formatCount(counters.population),
    },
    { key: "evacuating", label: "Still evacuating", value: formatCount(counters.evacuating) },
    { key: "queued", label: "Vehicles queued", value: formatCount(counters.vehiclesQueued) },
    {
      key: "crews",
      label: "Fire crews deployed",
      value: formatCount(counters.crewsDeployed),
      total: formatCount(counters.crewsTotal),
    },
  ];

  return (
    <Panel glass compact className="dio-counters" aria-label="Simulated counters">
      {items.map((item) => (
        <Metric
          key={item.key}
          className={`dio-counter dio-counter--${item.key}`}
          label={item.label}
          value={
            <>
              {item.value}
              {item.total !== undefined && (
                <span className="dio-counter-total"> / {item.total}</span>
              )}
            </>
          }
        />
      ))}
    </Panel>
  );
}

export default memo(Counters);
