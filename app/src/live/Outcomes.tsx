import { useMemo } from "react";
import { EvidenceTag, LoadingState, Metric, MetricGrid, ProgressBar } from "../ui";
import { nf, simClock } from "../demo/format";
import type { Board, ZoneForecast } from "../demo/model";
import { boardOutcomes, CLOSE_CALL_MINUTES, FORECAST_MINUTES, type Count } from "../demo/outcomes";
import { isReported } from "../demo/boardResponse";
import { containmentPct } from "../demo/observation";

/** Persons, or "unknown" when some zone's occupants are not known (never 0 for unknown). */
const people = (n: number | null) => (n === null ? "unknown" : nf(n));
const households = (n: number) => `${nf(n)} household${n === 1 ? "" : "s"}`;
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
/** Share of `of` that `part` is, by persons when both are known, else by households. */
function share(part: Count, of: Count): { value: number; basis: "people" | "households" } {
  if (part.people !== null && of.people !== null) return { value: of.people > 0 ? part.people / of.people : 0, basis: "people" };
  return { value: of.households > 0 ? part.households / of.households : 0, basis: "households" };
}
const DESTINATIONS_SHOWN = 4;

/**
 * The simulated board's evacuation picture for the right column: people out of the total, a
 * progress bar (threatened zones when any, else overall), who is on the road, still in
 * threatened zones, unable to reach safety and close calls, arrivals by destination and a fires
 * line. Every number is the board model's (demo/outcomes.ts); each one's meaning is under "How
 * these are counted".
 */
export default function Outcomes({
  board,
  version,
  forecasts,
}: {
  board: Board | null;
  /** Changes whenever the board (mutated in place) does. */
  version: number;
  forecasts: Map<string, ZoneForecast>;
}) {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the board is mutated in place; version marks changes
  const o = useMemo(() => (board ? boardOutcomes(board, forecasts) : null), [board, version, forecasts]);

  if (!o) {
    return (
      <section className="lc-out" aria-labelledby="lc-out-title">
        <header className="lc-out-head">
          <h2 id="lc-out-title">Evacuation</h2>
          <EvidenceTag kind="simulated" />
        </header>
        <LoadingState>Waiting for the simulated board…</LoadingState>
      </section>
    );
  }

  const threatened = o.threatenedZones > 0;
  const bar = threatened ? share(o.threatenedOut, o.threatenedAll) : share(o.out, o.total);
  const barScope = threatened
    ? `of the ${nf(o.threatenedZones)} threatened zone${o.threatenedZones === 1 ? "" : "s"}`
    : "overall (no zone threatened)";
  const barPart = bar.basis === "people" ? (threatened ? o.threatenedOut.people : o.out.people) : null;
  const barWhole = bar.basis === "people" ? (threatened ? o.threatenedAll.people : o.total.people) : null;
  const barText =
    bar.basis === "people"
      ? `${nf(barPart ?? 0)} of ${nf(barWhole ?? 0)} people out ${barScope}`
      : `${nf(threatened ? o.threatenedOut.households : o.out.households)} of ${households(
          threatened ? o.threatenedAll.households : o.total.households,
        )} out ${barScope} (persons unknown)`;
  const shownDest = o.destinations.slice(0, DESTINATIONS_SHOWN);
  const moreDest = o.destinations.length - shownDest.length;

  return (
    <section className="lc-out" aria-labelledby="lc-out-title">
      <header className="lc-out-head">
        <h2 id="lc-out-title">Evacuation</h2>
        <EvidenceTag kind="simulated" />
        <span className="lc-num lc-dim lc-out-time" aria-label={`as of simulated board time ${simClock(o.minute)}`}>
          {simClock(o.minute)}
        </span>
      </header>

      <div className="lc-out-hero">
        <p className="lc-out-big">
          <strong className="lc-num">{people(o.out.people)}</strong>
          <span>
            of {people(o.total.people)} people evacuated
          </span>
        </p>
        <p className="lc-out-sub lc-num">
          {nf(o.out.households)} of {households(o.total.households)} out
          {o.unknownHouseholds > 0 ? ` · ${households(o.unknownHouseholds)} with unknown occupants` : ""}
        </p>
        <ProgressBar value={bar.value} label={`Evacuation progress: ${barText}`} />
        {threatened ? (
          <p className="lc-out-sub">
            <strong className="lc-num">{pct(bar.value, 1)}%</strong> {barText}
          </p>
        ) : null}
      </div>

      <MetricGrid>
        <Metric
          label="On the road"
          value={people(o.enRoute.people)}
          detail={households(o.enRoute.households)}
        />
        {o.returning.households > 0 ? (
          <Metric
            label="Returning home"
            value={people(o.returning.people)}
            detail={`people driving back after an all clear (sim) · ${households(o.returning.households)}`}
          />
        ) : null}
        <Metric
          label="In threatened zones"
          value={people(o.threatenedHome.people)}
          detail={
            threatened
              ? `${nf(o.threatenedZones)} zone${o.threatenedZones === 1 ? "" : "s"}${
                  o.threatenedHomeScheduled.households > 0
                    ? ` · ${people(o.threatenedHomeScheduled.people)} scheduled`
                    : ""
                }${
                  o.threatenedHomeNoOrder.households > 0
                    ? ` · ${people(o.threatenedHomeNoOrder.people)} no order`
                    : ""
                }`
              : "None threatened"
          }
        />
        <Metric
          label="Unable to reach safety"
          value={people(o.unable.people)}
          detail={`${people(o.caught.people)} caught · ${people(o.needsTransport.people)} need transport`}
        />
        <Metric
          label="Homes burned"
          value={nf(o.homes.burned)}
          detail={`${nf(o.homes.zones)} zone${o.homes.zones === 1 ? "" : "s"} · ${nf(o.homes.reachedSaved)} saved`}
        />
        <Metric
          label="Close calls"
          value={people(o.closeCalls.people)}
          detail={`under ${CLOSE_CALL_MINUTES} min · ${households(o.closeCalls.households)}`}
        />
      </MetricGrid>

      {shownDest.length ? (
        <div className="lc-out-dest">
          <h3>Arrived by destination</h3>
          <ul>
            {shownDest.map((d) => (
              <li key={d.id}>
                <span className="lc-out-dest-name">{d.name}</span>
                <span className="lc-num">{people(d.people)} people</span>
              </li>
            ))}
          </ul>
          {moreDest > 0 ? <p className="lc-dim">and {nf(moreDest)} more</p> : null}
        </div>
      ) : null}

      <p className="lc-out-fires lc-num">
        Fires: {nf(o.fires.burning)} burning, {nf(o.fires.contained)} contained, {nf(o.fires.outTotal)} out ·{" "}
        {nf(o.fires.burnedHa)} ha burned
      </p>

      {board && board.fires.some((fire) => isReported(board, fire)) ? (
        <div className="ui-stack ui-inset" role="group" aria-label="Simulated fire containment">
          <strong>Fire containment</strong>
          {board.fires.filter((fire) => isReported(board, fire)).map((fire) => {
            const percent = containmentPct(fire);
            const label = fire.status === "out"
              ? `${fire.id} · Resolved`
              : `${fire.id} · ${percent}% contained`;
            return (
              <div key={fire.id} className="ui-stack">
                <span className="lc-num">{label}</span>
                <ProgressBar value={percent / 100} label={label} />
                {fire.status === "contained" ? <span className="lc-dim">Mop-up in progress</span> : null}
              </div>
            );
          })}
          <span className="lc-dim">Modelled containment; 100% contained does not mean extinguished.</span>
        </div>
      ) : null}

      <details className="lc-out-help">
        <summary>How these are counted</summary>
        <dl>
          <dt>People evacuated</dt>
          <dd>
            Persons whose household has arrived at its route's destination (exit, shelter or refuge) by the board time,
            after the congested drive. Total = every zone's occupants from the resource snapshot. Households are shown
            beside persons; persons are "unknown" when a zone's occupants are not all known.
          </dd>
          <dt>Progress bar</dt>
          <dd>
            People out among everyone living in the threatened zones (all zones when none is threatened). A zone is
            threatened when fire has touched it or the board's fire forecast reaches any part of it within{" "}
            {FORECAST_MINUTES} simulated minutes (current wind held; a fire counts only up to its estimated
            containment).
          </dd>
          <dt>On the road</dt>
          <dd>Left home and not yet arrived (in traffic or driving).</dd>
          <dt>Still in threatened zones</dt>
          <dd>
            Persons still home in threatened zones, those without a vehicle included. "Scheduled to leave": in zones
            whose evacuation order starts at a later board minute (they stay home until then). "With no order": in
            zones with no order in effect or scheduled; only households leaving on their own cues (simulated self-evacuation) go.
          </dd>
          <dt>Unable to reach safety</dt>
          <dd>
            Caught: still home when fire reached their zone's core (zones still overrun; {people(o.caughtRun.people)}{" "}
            over the whole run, including zones since reopened). Need transport: persons of households without a
            vehicle still home in threatened zones; the board has no pickup, so they cannot leave on their own. This
            drill assumes every household has a vehicle (the snapshot's carless households drive one car each), so
            it is 0 here.
          </dd>
          <dt>Close calls</dt>
          <dd>
            Left home less than {CLOSE_CALL_MINUTES} simulated minutes before fire reached their zone's core (the
            model catches whoever is still home then), in zones still overrun. Departure minutes are the traffic
            model's whole-minute steps, so a margin can read up to 1 min short. The {CLOSE_CALL_MINUTES}-minute
            threshold is an assumption for display.
          </dd>
          <dt>Homes burned</dt>
          <dd>
            {o.homes.method} A home on a cell still burning counts as burned; one on a cell crews put out before it
            burned out counts as reached and saved.
          </dd>
          <dt>Arrived by destination</dt>
          <dd>Arrivals so far, by the destination each household left toward.</dd>
        </dl>
        <p className="lc-dim">
          Simulated board in this browser: model results, not observed counts. Board time T+hh:mm since the board
          started.
        </p>
      </details>
    </section>
  );
}
