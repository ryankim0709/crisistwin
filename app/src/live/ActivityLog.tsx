import { useState } from "react";
import { Tag } from "../ui";
import { elapsed } from "./format";
import type { Decision } from "./types";
import "./activity.css";

const VERBS: Record<string, string> = {
  confirm: "Confirmed report",
  dismiss: "Dismissed report",
  merge: "Merged reports",
  resolve: "Resolved report",
  task_create: "Requested field check",
  task_cancel: "Cancelled field check",
  approve: "Approved guidance",
  reject: "Rejected guidance",
  auto_approve: "Auto-approved reroute",
  drill_start: "Drill started",
  drill_pause: "Drill paused",
  drill_resume: "Drill resumed",
  drill_reset: "Drill reset",
  help_acknowledge: "Acknowledged help request",
  help_assign: "Assigned responder to help request",
  help_resolve: "Resolved help request",
};

function verb(action: string): string {
  if (VERBS[action]) return VERBS[action];
  const words = action.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const DEFAULT_ROWS = 8;

export default function ActivityLog({
  decisions,
  serverNow,
  onSelect,
}: {
  decisions: Decision[];
  serverNow: number;
  onSelect: (reportIds: string[]) => boolean;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? decisions : decisions.slice(0, DEFAULT_ROWS);
  return (
    <details className="lc-act" open>
      <summary>Activity</summary>
      {decisions.length === 0 ? (
        <p className="lc-dim">No decisions yet</p>
      ) : (
        <ul className="lc-act-list">
          {shown.map((d, i) => {
            const auto = d.actor === "auto_policy";
            const text = verb(d.action);
            const age = elapsed(serverNow - new Date(d.at).getTime());
            const content = (
              <>
                <span className="lc-act-time lc-num">{age}</span>
                <span className="lc-act-verb">{text}</span>
                {auto ? <Tag tone="info">Automatic</Tag> : null}
              </>
            );
            return (
              <li key={`${d.at}-${i}`}>
                {d.report_ids.length ? (
                  <button type="button" className="lc-act-row" title={d.note ?? undefined} onClick={() => onSelect(d.report_ids)}>
                    {content}
                  </button>
                ) : (
                  <span className="lc-act-row" title={d.note ?? undefined}>
                    {content}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {decisions.length > DEFAULT_ROWS ? (
        <button type="button" className="lc-act-more" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${decisions.length}`}
        </button>
      ) : null}
    </details>
  );
}
