// /replay route: which fire to replay. The choice lives in ?incident= so links and reloads keep it.
import { useEffect, useState } from "react";
import {
  DEFAULT_INCIDENT_ID,
  REPLAY_INCIDENTS,
  bundleExists,
  fetchIncidents,
  replayViewFor,
  type ReplayIncident,
} from "./loadBundle";
import ReplayView from "./ReplayView";

/** true = bundle served, false = not generated, undefined = still checking or check failed. */
type Availability = Record<string, boolean | undefined>;

/** Camp stays the default when the index lists it; else the index's first fire. */
function defaultIncident(incidents: ReplayIncident[]): ReplayIncident {
  return incidents.find((i) => i.id === DEFAULT_INCIDENT_ID) ?? incidents[0];
}

function incidentFromUrl(incidents: ReplayIncident[]): ReplayIncident {
  const id = new URLSearchParams(window.location.search).get("incident");
  return incidents.find((i) => i.id === id) ?? defaultIncident(incidents);
}

/**
 * Incidents from /replays/index.json; null while loading. Falls back to the built-in list
 * when the index is missing or invalid.
 */
function useIncidents(): ReplayIncident[] | null {
  const [incidents, setIncidents] = useState<ReplayIncident[] | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetchIncidents(controller.signal)
      .then((list) => setIncidents(list ?? REPLAY_INCIDENTS))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("Incidents index unavailable; using the built-in list", error);
        setIncidents(REPLAY_INCIDENTS);
      });
    return () => controller.abort();
  }, []);
  return incidents;
}

function useAvailability(incidents: ReplayIncident[]): Availability {
  const [availability, setAvailability] = useState<Availability>({});
  useEffect(() => {
    const controller = new AbortController();
    for (const incident of incidents) {
      bundleExists(incident.bundleUrl, controller.signal)
        .then((ok) => setAvailability((prev) => ({ ...prev, [incident.id]: ok })))
        .catch(() => {
          // Aborted or network error: leave unknown, so the option stays selectable.
        });
    }
    return () => controller.abort();
  }, [incidents]);
  return availability;
}

export function IncidentPicker({
  incidents,
  value,
  availability,
  onChange,
}: {
  incidents: ReplayIncident[];
  value: string;
  availability: Availability;
  onChange: (id: string) => void;
}) {
  return (
    <label className="rp-incident-picker">
      <span className="rp-eyebrow">Fire</span>
      <select className="rp-select" value={value} onChange={(e) => onChange(e.target.value)}>
        {incidents.map((incident) => {
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

/** "Camp Fire (2018) · Paradise, …" -> "Camp 2018". */
function shortLabel(incident: ReplayIncident): string {
  const name = incident.label.split(" · ")[0];
  const year = name.match(/\((\d{4})\)/)?.[1] ?? incident.id.match(/(\d{4})/)?.[1] ?? "";
  const base = name
    .replace(/\(\d{4}\)/, "")
    .replace(/\s*\bFire\b/i, "")
    .trim();
  return year && !base.includes(year) ? `${base} ${year}` : base;
}

/** Always-visible fire switcher on the map (segmented control); mirrors the panel dropdown. */
export function FireSwitcher({
  incidents,
  value,
  availability,
  onChange,
}: {
  incidents: ReplayIncident[];
  value: string;
  availability: Availability;
  onChange: (id: string) => void;
}) {
  if (incidents.length < 2) return null;
  return (
    <div className="rp-fire-switch" role="group" aria-label="Choose a fire">
      {incidents.map((incident) => {
        const missing = availability[incident.id] === false;
        return (
          <button
            key={incident.id}
            type="button"
            aria-pressed={incident.id === value}
            disabled={missing && incident.id !== value}
            title={incident.label + (missing ? " (not built yet)" : "")}
            onClick={() => onChange(incident.id)}
          >
            {shortLabel(incident)}
          </button>
        );
      })}
    </div>
  );
}

export default function ReplayRoute() {
  const incidents = useIncidents();
  if (incidents === null) return null;
  return <ReplayRouteWith incidents={incidents} />;
}

function ReplayRouteWith({ incidents }: { incidents: ReplayIncident[] }) {
  const [incident, setIncident] = useState(() => incidentFromUrl(incidents));
  const availability = useAvailability(incidents);

  useEffect(() => {
    const onPop = () => setIncident(incidentFromUrl(incidents));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [incidents]);

  function select(id: string, story = false) {
    const next = incidents.find((i) => i.id === id);
    if (!next || next.id === incident.id) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("tab");
    url.searchParams.delete("variant");
    if (story) url.searchParams.set("story", "1");
    else url.searchParams.delete("story");
    if (next.id === defaultIncident(incidents).id) url.searchParams.delete("incident");
    else url.searchParams.set("incident", next.id);
    window.history.pushState(null, "", url);
    setIncident(next);
  }

  return (
    // Keyed so a new fire starts from a fresh load, clock and panel state; the load inside
    // ReplayView aborts when its key changes.
    <ReplayView
      key={incident.id}
      config={replayViewFor(incident)}
      picker={
        <IncidentPicker
          incidents={incidents}
          value={incident.id}
          availability={availability}
          onChange={select}
        />
      }
      nextFire={(() => {
        // The next built fire after this one, wrapping around.
        const at = incidents.findIndex((i) => i.id === incident.id);
        for (let k = 1; k < incidents.length; k += 1) {
          const candidate = incidents[(at + k) % incidents.length];
          if (availability[candidate.id] === false) continue;
          return { label: shortLabel(candidate), open: () => select(candidate.id, true) };
        }
        return null;
      })()}
      switcher={
        <FireSwitcher
          incidents={incidents}
          value={incident.id}
          availability={availability}
          onChange={select}
        />
      }
    />
  );
}
