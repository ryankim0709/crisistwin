import { useState } from "react";
import { Button, EvidenceTag, Tag } from "../ui";
import { drillClock, shortZoneName } from "./format";
import type { CommandZone, GroundChannel, GroundRecord as Record } from "./types";
import "./response.css";

const CHANNEL_LABEL: { [K in GroundChannel]: string } = {
  "911": "911",
  radio: "Radio",
  rescue: "Rescue",
  notification: "Notice",
  evacuation: "Evacuation",
};
const DEFAULT_ROWS = 8;

const sourceUrl = (locator: string | null) => locator?.split(";")[0]?.trim() || null;

/** What 911 callers, radio traffic and rescue requests said in 2018, up to the drill time:
 * the ground truth the drill's own field reports are compared against. Historical and
 * de-identified (template summaries, zone only). */
export default function GroundRecord({
  record,
  zones,
  onFocusZone,
}: {
  record: Record | undefined;
  zones: CommandZone[];
  onFocusZone: (zoneId: string) => void;
}) {
  const [all, setAll] = useState(false);
  if (!record?.available) return null;
  const zoneName = new Map(zones.map((z) => [z.id, shortZoneName(z.name)]));
  const shown = all ? record.items : record.items.slice(0, DEFAULT_ROWS);
  const w = record.window;
  return (
    <details className="rr" open>
      <summary>2018 calls and radio</summary>
      <p className="rr-stats lc-num" aria-label={`Last ${record.window_min} minutes of drill time`}>
        Last {record.window_min} min: {w["911"]} 911 · {w.radio} radio · {w.rescue} rescue
      </p>
      {record.items.length === 0 ? (
        <p className="rr-empty">Nothing recorded yet</p>
      ) : (
        <ul className="rr-list">
          {shown.map((it) => {
            const url = sourceUrl(it.source_locator);
            return (
              <li key={it.id} className="rr-row">
                <span className="rr-time lc-num">{drillClock(it.at)}</span>
                <span className="rr-body">
                  <span className="rr-tags">
                    <Tag tone={it.category === "trapped" || it.category === "help_needed" ? "danger" : undefined}>
                      {CHANNEL_LABEL[it.channel] ?? it.channel}
                    </Tag>
                    <EvidenceTag kind={it.evidence_class} />
                    {it.zone_id && zoneName.has(it.zone_id) ? (
                      <Button variant="ghost" size="sm" onClick={() => onFocusZone(it.zone_id!)}>
                        {zoneName.get(it.zone_id)}
                      </Button>
                    ) : null}
                  </span>
                  <span className="rr-label">{it.summary}</span>
                </span>
                {url ? (
                  <a className="rr-src" href={url} target="_blank" rel="noreferrer" title={it.source_locator ?? undefined}>
                    Source
                  </a>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {record.items.length > DEFAULT_ROWS ? (
        <Button variant="ghost" size="sm" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${record.items.length}`}
        </Button>
      ) : null}
    </details>
  );
}
