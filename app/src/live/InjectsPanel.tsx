// Instructor panel (the /live "..." menu, "Injects"): a form per inject type, the list with status,
// and delete. Injects are simulated stress events for the drill; nothing is sent to anyone.
import { useEffect, useState, type FormEvent } from "react";
import { Button, IconButton, Notice, Tag, type TagTone } from "../ui";
import { drillClock, shortZoneName } from "./format";
import {
  INJECT_LABEL,
  INJECT_TYPES,
  createInject,
  deleteInject,
  listInjects,
  type InjectStatus,
  type InjectType,
  type SegmentChoice,
} from "./injects";
import type { RunAction } from "./SelectedItem";
import type { CommandResponse } from "./types";
import "./injects.css";

const STATUS_TONE: Record<InjectStatus, TagTone> = { scheduled: "neutral", active: "warning", ended: "neutral" };
const TIME_RE = /^\d{2}:\d{2}$/;

export default function InjectsPanel({ data, run, busy }: { data: CommandResponse; run: RunAction; busy: string | null }) {
  const [type, setType] = useState<InjectType>("comms_outage");
  const [zones, setZones] = useState<string[]>([]);
  const [segment, setSegment] = useState("");
  const [destination, setDestination] = useState("");
  const [coord, setCoord] = useState("-121.6, 39.76");
  const [at, setAt] = useState("");
  const [until, setUntil] = useState("");
  const [to, setTo] = useState("");
  const [segments, setSegments] = useState<SegmentChoice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const injects = data.injects ?? [];
  const shelters = data.destinations.filter((d) => d.kind !== "exit");
  const day = data.drill.replay_now.slice(0, 10);

  useEffect(() => {
    if (type !== "silent_closure" || segments.length) return;
    void run("injects:choices", async (token) => setSegments((await listInjects(token)).choices.segments));
  }, [type, segments.length, run]);

  const time = (value: string) => `${day}T${value}:00Z`;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const params: Record<string, unknown> = {};
    if (type === "psap_reroute" || type === "comms_outage") {
      params.zone_ids = zones;
      if (until) params.until = time(until);
      if (type === "psap_reroute" && to.trim()) params.to = to.trim();
    } else if (type === "silent_closure") params.segment_id = segment;
    else if (type === "shelter_full") params.destination_id = destination;
    else {
      const [lon, lat] = coord.split(",").map((v) => Number(v.trim()));
      params.coord = [lon, lat];
    }
    const message = await run("injects:add", (token) =>
      createInject(token, { type, params, ...(TIME_RE.test(at) ? { at: time(at) } : {}) }),
    );
    setError(message);
  };

  return (
    <div className="lc-inj">
      <form onSubmit={(e) => void submit(e)} aria-label="New inject">
        <label>
          Type
          <select value={type} onChange={(e) => setType(e.target.value as InjectType)}>
            {INJECT_TYPES.map((t) => (
              <option key={t} value={t}>
                {INJECT_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        {type === "psap_reroute" || type === "comms_outage" ? (
          <label>
            Zones
            <select
              multiple
              size={5}
              value={zones}
              onChange={(e) => setZones(Array.from(e.target.selectedOptions, (o) => o.value))}
            >
              {data.zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {shortZoneName(z.name)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {type === "silent_closure" ? (
          <label>
            Road
            <select value={segment} onChange={(e) => setSegment(e.target.value)}>
              <option value="">Choose</option>
              {segments.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}, {(s.length_m / 1000).toFixed(1)} km
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {type === "shelter_full" ? (
          <label>
            Shelter
            <select value={destination} onChange={(e) => setDestination(e.target.value)}>
              <option value="">Choose</option>
              {shelters.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {type === "fire_jump" ? (
          <label>
            Lon, lat
            <input value={coord} onChange={(e) => setCoord(e.target.value)} inputMode="decimal" />
          </label>
        ) : null}
        {type === "psap_reroute" ? (
          <label>
            Sent to
            <input value={to} maxLength={80} placeholder="Chico PSAP" onChange={(e) => setTo(e.target.value)} />
          </label>
        ) : null}
        <div className="lc-inj-times">
          <label>
            From (UTC)
            <input type="time" value={at} onChange={(e) => setAt(e.target.value)} title="Blank is now" />
          </label>
          {type === "psap_reroute" || type === "comms_outage" ? (
            <label>
              Until (UTC)
              <input type="time" value={until} onChange={(e) => setUntil(e.target.value)} required={type === "comms_outage"} />
            </label>
          ) : null}
        </div>
        {error ? (
          <Notice tone="danger" compact>
            {error}
          </Notice>
        ) : null}
        <Button size="sm" type="submit" disabled={busy !== null}>
          Add inject
        </Button>
        <small className="lc-dim">Simulated. Nothing is sent to anyone.</small>
      </form>
      <ul className="lc-inj-list" aria-label="Injects">
        {injects.map((i) => (
          <li key={i.id}>
            <span className="lc-num lc-dim">{drillClock(i.at)}</span>
            <span className="lc-inj-label">{i.label.replace(/^Injected \(simulated\): /, "")}</span>
            <Tag tone={STATUS_TONE[i.status]}>{i.status}</Tag>
            <IconButton
              label={`Delete ${INJECT_LABEL[i.type]}`}
              size="sm"
              disabled={busy !== null}
              onClick={() => void run("injects:delete", (token) => deleteInject(token, i.id)).then(setError)}
            >
              ×
            </IconButton>
          </li>
        ))}
        {injects.length === 0 ? <li className="lc-dim">None</li> : null}
      </ul>
    </div>
  );
}
