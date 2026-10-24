import { useState } from "react";
import { EvidenceTag, Tag } from "../ui";
import { drillClock } from "./format";
import type { ResponseRecordItem } from "./types";
import "./response.css";

const TYPE_TAGS: Record<string, string> = {
  evacuation_order: "Order",
  evacuation_warning: "Warning",
  alert_sent: "Alert",
  contraflow_started: "Contraflow",
  road_closed: "Closure",
  road_blocked: "Closure",
  shelter_opened: "Shelter",
  shelter_closed: "Shelter",
  capacity_changed: "Capacity",
  burnover: "Burnover",
  vehicles_trapped: "Trapped",
  fire_arrival: "Fire",
  fire_reported: "Fire",
  fire_ignition: "Fire",
  perimeter_observed: "Perimeter",
};

const DEFAULT_ROWS = 8;

function typeTag(type: string): string {
  if (TYPE_TAGS[type]) return TYPE_TAGS[type];
  const words = type.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Drop the bracketed technical suffix, e.g. "[snapped: ...]". */
function cleanLabel(label: string): string {
  return label.replace(/\s*\[[^\]]*\]\s*/g, " ").trim();
}

/** The historical 2018 Camp Fire response record up to the drill time. Not drill decisions. */
export default function ResponseRecord({ items }: { items: ResponseRecordItem[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, DEFAULT_ROWS);
  return (
    <details className="rr" open>
      <summary>2018 response</summary>
      {items.length === 0 ? (
        <p className="rr-empty">No recorded events yet</p>
      ) : (
        <ul className="rr-list">
          {shown.map((it) => (
            <li key={it.id} className="rr-row">
              <span className="rr-time lc-num">{drillClock(it.at)}</span>
              <span className="rr-body">
                <span className="rr-tags">
                  <Tag>{typeTag(it.type)}</Tag>
                  <EvidenceTag kind={it.evidence_class} />
                </span>
                <span className="rr-label" title={it.label}>
                  {cleanLabel(it.label)}
                </span>
              </span>
              {it.source_url ? (
                <a className="rr-src" href={it.source_url} target="_blank" rel="noreferrer" title={it.source_id ?? undefined}>
                  Source
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {items.length > DEFAULT_ROWS ? (
        <button type="button" className="rr-more" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${items.length}`}
        </button>
      ) : null}
    </details>
  );
}
