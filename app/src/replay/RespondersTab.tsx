import { EvidenceChip } from "./parts";
import { splitSnappedNote } from "./narrative";
import type { RespondersComparison } from "./types";

function timing(deltaMin: number | null): string {
  if (deltaMin === null) return "not comparable";
  if (deltaMin === 0) return "same time";
  const minutes = Math.abs(Math.round(deltaMin));
  return `${minutes} min ${deltaMin < 0 ? "earlier" : "later"} than reported`;
}

/** Agent simulation only: simulated responder actions next to recorded 2018 actions. */
export default function RespondersTab({ responders }: { responders: RespondersComparison }) {
  return (
    <div className="rp-tab">
      <p className="rp-disclaimer rp-disclaimer--top" role="note">
        <EvidenceChip value={responders.evidenceClass} /> Responder agents are simulated decision rules, compared
        with responder actions reported for 2018. A match means the same kind of action on a road with the same name,
        not that the model reproduced what happened.
      </p>

      <section aria-labelledby="rp-resp-matches">
        <h3 id="rp-resp-matches" className="rp-section-title">
          Responders vs 2018 <span className="rp-count">{responders.matches.length} matched</span>
        </h3>
        {responders.matches.length === 0 ? (
          <p className="rp-empty">No simulated action matched a reported one.</p>
        ) : (
          <ul className="rp-rows">
            {responders.matches.map((m, i) => {
              const historical = splitSnappedNote(m.historical.label);
              return (
                <li key={i} className="rp-row-static rp-resp-match">
                  <span className="rp-row-main">
                    {m.simulated.kind ?? "Action"} on {m.simulated.road ?? m.historical.road ?? "road"}:{" "}
                    {timing(m.deltaMin)}
                  </span>
                  <span className="rp-resp-line">
                    <EvidenceChip value="simulated" /> {m.simulated.localTime ?? "—"} PST ·{" "}
                    {m.simulated.label.replace(/^Responder agent \(simulated\):\s*/, "")}
                  </span>
                  <span className="rp-resp-line">
                    {m.historical.evidenceClass && <EvidenceChip value={m.historical.evidenceClass} />}{" "}
                    {m.historical.localTime ?? "—"} PST · {historical.text}
                    {m.historical.locator && (
                      <>
                        {" "}
                        <a href={m.historical.locator} target="_blank" rel="noreferrer" className="rp-source-link">
                          source
                        </a>
                      </>
                    )}
                  </span>
                  {historical.note && <span className="rp-snapped">{historical.note}</span>}
                </li>
              );
            })}
          </ul>
        )}
        {responders.rule && <p className="rp-rule">Matching rule: {responders.rule}</p>}
      </section>

      {responders.simulatedOnly.length > 0 && (
        <details className="rp-notes">
          <summary>Simulated actions with no 2018 counterpart ({responders.simulatedOnly.length})</summary>
          <ul>
            {responders.simulatedOnly.map((a, i) => (
              <li key={i}>
                {a.localTime ?? "—"} · {a.label.replace(/^Responder agent \(simulated\):\s*/, "")}
                {a.reason && <span className="rp-snapped">{a.reason}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {responders.historicalOnly.length > 0 && (
        <details className="rp-notes">
          <summary>Reported 2018 actions with no simulated counterpart ({responders.historicalOnly.length})</summary>
          <ul>
            {responders.historicalOnly.map((a, i) => (
              <li key={i}>
                {a.localTime ?? "—"} · {splitSnappedNote(a.label).text}
                {a.reason && <span className="rp-snapped">{a.reason}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
