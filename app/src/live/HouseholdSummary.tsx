import { EvidenceTag, Spinner } from "../ui";
import { simClock } from "../demo/format";
import { HOUSEHOLD_DETAIL, HOUSEHOLD_LABEL, HOUSEHOLD_NOTE, HOUSEHOLD_STYLE } from "./householdLayer";
import { HOUSEHOLD_STATUSES, type HouseholdState, type HouseholdStatus } from "./useHouseholdState";
import "./households.css";

/** A status swatch drawn from the same path, colours and mark as the map icon. */
export function HouseSwatch({ status }: { status: HouseholdStatus }) {
  const s = HOUSEHOLD_STYLE[status];
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="lc-house-sw">
      <path d={s.shape} fill="none" stroke="#fff" strokeWidth="3.6" strokeLinejoin="round" />
      <path d={s.shape} fill={s.fill} stroke={s.edge} strokeWidth="1.5" strokeLinejoin="round" strokeDasharray={s.dashed ? "2 1.5" : undefined} />
      {s.mark ? (
        <path
          d={s.mark}
          fill="none"
          stroke={s.markColor ?? s.edge}
          strokeWidth={s.mark.endsWith("h.01") ? 2.6 : 1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
    </svg>
  );
}

const nf = (n: number) => n.toLocaleString("en-US");

/**
 * Strip over the map while the Houses layer is on: simulated household counts by status (with the
 * map's shapes), the board time, and why nothing is drawn when the incident has no snapshot.
 */
export default function HouseholdSummary({ state }: { state: HouseholdState }) {
  const { households, snapshot, reason, loading, error, boardMinute } = state;
  const label = "Houses, simulated";
  if (snapshot === null) {
    return (
      <section className="lc-houses" aria-label={label} aria-live="polite">
        <EvidenceTag kind="simulated" />
        <span className="lc-houses-msg">
          {error ? (
            error.status === 404 ? (
              "Household state is not available on this server yet."
            ) : (
              `Houses unavailable: ${error.message}`
            )
          ) : loading ? (
            <>
              <Spinner /> Loading simulated households…
            </>
          ) : (
            "No household state."
          )}
        </span>
      </section>
    );
  }
  if (!snapshot) {
    return (
      <section className="lc-houses" aria-label={label} aria-live="polite">
        <EvidenceTag kind="simulated" />
        <span className="lc-houses-msg">No houses drawn: {reason}</span>
      </section>
    );
  }
  const counts = new Map<HouseholdStatus, number>();
  for (const h of households.values()) counts.set(h.status, (counts.get(h.status) ?? 0) + 1);
  const shown = HOUSEHOLD_STATUSES.filter((s) => (counts.get(s) ?? 0) > 0);
  return (
    <section className="lc-houses" aria-label={label}>
      <EvidenceTag kind="simulated" />
      {households.size === 0 ? (
        <span className="lc-houses-msg">No households in this run yet.</span>
      ) : (
        <ul className="lc-houses-chips">
          {shown.map((s) => (
            <li key={s} className="lc-houses-chip" title={HOUSEHOLD_DETAIL[s]}>
              <HouseSwatch status={s} />
              <span className="lc-houses-chip-label">{HOUSEHOLD_LABEL[s]}</span>
              <strong className="lc-houses-chip-value">{nf(counts.get(s) ?? 0)}</strong>
            </li>
          ))}
        </ul>
      )}
      <span className="lc-houses-meta">
        {nf(households.size)} houses{boardMinute !== null ? `, ${simClock(boardMinute)}` : ""}
      </span>
      {error ? <span className="lc-houses-stale">Not updating</span> : null}
      <details className="lc-houses-key">
        <summary>About</summary>
        <p className="lc-houses-pop">{HOUSEHOLD_NOTE}. Hover or click a house for its status.</p>
      </details>
    </section>
  );
}
