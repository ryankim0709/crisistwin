import type { ReactNode } from "react";
import { EvidenceTag, Spinner } from "../../ui";
import type { LiveError } from "../api";
import { PEOPLE_COLOR as C } from "./palette";
import { peoplePerDot } from "./peopleLayer";
import type { PeopleSnapshot, StuckReason } from "./types";
import "./people.css";

const nf = (n: number) => Math.round(n).toLocaleString("en-US");

const svg = (children: ReactNode) => (
  <svg viewBox="0 0 20 14" aria-hidden="true">
    {children}
  </svg>
);

/** Swatches drawn like the map marks (shape plus colour). */
export const PEOPLE_SWATCH = {
  home: svg(<circle cx="10" cy="7" r="5.5" fill={C.home} fillOpacity="0.6" stroke={C.homeEdge} strokeWidth="1.5" />),
  driving: svg(
    <>
      <line x1="1" y1="7" x2="19" y2="7" stroke={C.drivingEdge} strokeOpacity="0.25" strokeWidth="1" />
      <circle cx="4" cy="7" r="2.4" fill={C.driving} stroke={C.drivingEdge} strokeWidth="0.8" />
      <circle cx="10" cy="7" r="2.4" fill={C.driving} stroke={C.drivingEdge} strokeWidth="0.8" />
      <circle cx="16" cy="7" r="2.4" fill={C.driving} stroke={C.drivingEdge} strokeWidth="0.8" />
    </>,
  ),
  queued: svg(
    <>
      <line x1="1" y1="7" x2="19" y2="7" stroke={C.queued} strokeWidth="4" strokeLinecap="round" />
      <circle cx="12" cy="7" r="2" fill={C.queued} stroke={C.queuedEdge} strokeWidth="0.8" />
      <circle cx="16" cy="7" r="2" fill={C.queued} stroke={C.queuedEdge} strokeWidth="0.8" />
    </>,
  ),
  stuck: svg(<circle cx="10" cy="7" r="5" fill={C.stuck} fillOpacity="0.2" stroke={C.stuck} strokeWidth="2" />),
  out: svg(<circle cx="10" cy="7" r="5" fill={C.out} stroke="#fff" strokeWidth="1.5" />),
};

const REASON_LABEL: Record<StuckReason, string> = {
  long_queue: "in traffic 15+ min",
  road_closed: "road closed ahead",
  fire: "cut off by fire",
  no_route: "no open way out",
  turned_back: "turned back",
};

interface Props {
  snapshot: PeopleSnapshot | null;
  error: LiveError | null;
  className?: string;
  /** Mention that app users' phones are a separate layer (true on /live). */
  phonesNote?: boolean;
  /** A short plain-language line shown after the counts (for example why nobody is moving). */
  note?: ReactNode;
}

/**
 * Plain-language summary of the simulated people picture (Still home / Driving out / In traffic /
 * Stuck / Out) with a key to the map marks. Reusable beside any map that hosts `attachPeopleLayer`.
 */
export default function PeopleSummary({ snapshot, error, className, phonesNote = true, note }: Props) {
  const cls = `ppl-strip${className ? ` ${className}` : ""}`;
  if (!snapshot) {
    return (
      <section className={cls} aria-label="People, simulated" aria-live="polite">
        <EvidenceTag kind="simulated" />
        {error ? (
          <span className="ppl-msg">
            {error.code === "twin_warming" || error.code === "twin_busy"
              ? "People picture loading…"
              : `People picture unavailable: ${error.message}`}
          </span>
        ) : (
          <span className="ppl-msg">
            <Spinner /> Estimating where people are…
          </span>
        )}
      </section>
    );
  }
  const t = snapshot.totals.people;
  const home = t.home + t.home_no_car + t.staying;
  const stuckWhy = (Object.keys(snapshot.stuck_by_reason) as StuckReason[])
    .filter((r) => snapshot.stuck_by_reason[r] > 0)
    .map((r) => `${nf(snapshot.stuck_by_reason[r])} ${REASON_LABEL[r]}`)
    .join(", ");
  const chips: { key: keyof typeof PEOPLE_SWATCH; label: string; value: number; detail?: string; title: string }[] = [
    {
      key: "home",
      label: "People still home",
      value: home,
      detail: [t.home_no_car ? `${nf(t.home_no_car)} no car` : "", t.staying ? `${nf(t.staying)} staying put` : ""]
        .filter(Boolean)
        .join(", ") || undefined,
      title: `${nf(t.home)} have not left yet; ${nf(t.home_no_car)} live in a household without a car` +
        (t.staying ? `; ${nf(t.staying)} are staying put on purpose (or have no road nearby)` : ""),
    },
    { key: "driving", label: "Driving out", value: t.driving, title: "Moving on the road toward an exit or shelter" },
    {
      key: "queued",
      label: "In traffic",
      value: t.queued,
      title: `Waiting in a queue for under ${snapshot.long_queue_min} min, or waiting to get onto the road`,
    },
    { key: "stuck", label: "Stuck", value: t.stuck, title: stuckWhy ? `Stuck: ${stuckWhy}` : "Nobody stuck" },
    { key: "out", label: "Out", value: t.out, title: "Reached an exit, shelter or refuge" },
  ];
  const ppd = peoplePerDot(snapshot);
  return (
    <section className={cls} aria-label="People, simulated">
      <EvidenceTag kind="simulated" />
      <ul className="ppl-chips">
        {chips.map((c) => (
          <li key={c.key} className="ppl-chip" title={c.title}>
            <span className="ppl-sw">{PEOPLE_SWATCH[c.key]}</span>
            <span className="ppl-chip-label">{c.label}</span>
            <strong className="ppl-chip-value">{nf(c.value)}</strong>
            {c.detail ? <span className="ppl-chip-detail">{c.detail}</span> : null}
          </li>
        ))}
      </ul>
      {note ? <span className="ppl-note">{note}</span> : null}
      {error ? <span className="ppl-stale">Not updating</span> : null}
      <details className="ppl-key">
        <summary>Key</summary>
        <div className="ppl-key-pop">
        <ul>
          <li>
            <span className="ppl-sw">{PEOPLE_SWATCH.home}</span>Residents still home, per area
          </li>
          <li>
            <span className="ppl-sw">{PEOPLE_SWATCH.driving}</span>Driving out; 1 dot ≈ {ppd} people, moving the way they travel
            (sped up)
          </li>
          <li>
            <span className="ppl-sw">{PEOPLE_SWATCH.queued}</span>Waiting in traffic
          </li>
          <li>
            <span className="ppl-sw">{PEOPLE_SWATCH.stuck}</span>Stuck: {snapshot.long_queue_min}+ min in a queue, a closed road
            ahead, cut off by fire or no way out
          </li>
          <li>
            <span className="ppl-sw">{PEOPLE_SWATCH.out}</span>Reached an exit or shelter
          </li>
        </ul>
        <p>
          Estimates from the traffic simulation: {nf(t.population)} residents ({snapshot.basis.population}), about{" "}
          {snapshot.basis.persons_per_vehicle} per car; behaviour: {snapshot.basis.people_behavior}.
          {phonesNote ? " App users' phones are the separate dots." : null}
        </p>
        </div>
      </details>
    </section>
  );
}
