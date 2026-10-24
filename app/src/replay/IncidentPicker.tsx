// /replay route: which fire to replay. The choice lives in ?incident= so links and reloads keep it.
import { useEffect, useState } from "react";
import {
  DEFAULT_INCIDENT_ID,
  REPLAY_INCIDENTS,
  bundleExists,
  replayViewFor,
  type ReplayIncident,
} from "./loadBundle";
import ReplayView from "./ReplayView";

/** true = bundle served, false = not generated, undefined = still checking or check failed. */
type Availability = Record<string, boolean | undefined>;

function incidentFromUrl(): ReplayIncident {
  const id = new URLSearchParams(window.location.search).get("incident");
  return REPLAY_INCIDENTS.find((i) => i.id === id) ?? REPLAY_INCIDENTS[0];
}

function useAvailability(): Availability {
  const [availability, setAvailability] = useState<Availability>({});
  useEffect(() => {
    const controller = new AbortController();
    for (const incident of REPLAY_INCIDENTS) {
      bundleExists(incident.bundleUrl, controller.signal)
        .then((ok) => setAvailability((prev) => ({ ...prev, [incident.id]: ok })))
        .catch(() => {
          // Aborted or network error: leave unknown, so the option stays selectable.
        });
    }
    return () => controller.abort();
  }, []);
  return availability;
}

export function IncidentPicker({
  value,
  availability,
  onChange,
}: {
  value: string;
  availability: Availability;
  onChange: (id: string) => void;
}) {
  return (
    <label className="rp-incident-picker">
      <span className="rp-eyebrow">Fire</span>
      <select className="rp-select" value={value} onChange={(e) => onChange(e.target.value)}>
        {REPLAY_INCIDENTS.map((incident) => {
          const missing = availability[incident.id] === false && incident.id !== value;
          return (
            <option key={incident.id} value={incident.id} disabled={missing}>
              {incident.label}
              {availability[incident.id] === false ? " (not built yet)" : ""}
            </option>
          );
        })}
      </select>
    </label>
  );
}

export default function ReplayRoute() {
  const [incident, setIncident] = useState(incidentFromUrl);
  const availability = useAvailability();

  useEffect(() => {
    const onPop = () => setIncident(incidentFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function select(id: string) {
    const next = REPLAY_INCIDENTS.find((i) => i.id === id);
    if (!next || next.id === incident.id) return;
    const url = new URL(window.location.href);
    if (next.id === DEFAULT_INCIDENT_ID) url.searchParams.delete("incident");
    else url.searchParams.set("incident", next.id);
    window.history.pushState(null, "", url);
    setIncident(next);
  }

  return (
    // Keyed so a new fire starts from a fresh load, clock and panel state.
    <ReplayView
      key={incident.id}
      config={replayViewFor(incident)}
      picker={<IncidentPicker value={incident.id} availability={availability} onChange={select} />}
    />
  );
}
