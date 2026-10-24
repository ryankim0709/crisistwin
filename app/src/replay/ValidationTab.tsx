import { EvidenceChip } from "./parts";
import type { Validation, ValidationRow } from "./types";

/** How far each comparability grade lets a row be read; "tuned" is never validation. */
const GRADE_LABEL: Record<string, string> = {
  partial: "Partial match",
  weak: "Weak analogue",
  tuned: "Tuned — not validation",
  not_computed: "Not computed",
};

const MAX_MODEL_FIELDS = 4;

function humanize(key: string): string {
  return key
    .replace(/_at_local$/, " (local)")
    .replace(/_delta_min$/, " vs published (min)")
    .replace(/^delta_min$/, "vs published (min)")
    .replace(/(\d+)pct/g, "$1%")
    .replace(/_veh$/, " (veh)")
    .replace(/_/g, " ");
}

function metricTitle(metric: string): string {
  const text = metric.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatPublished(row: ValidationRow): string {
  if (row.published === null) return "—";
  const unit = row.unit ?? "";
  if (unit.startsWith("local_time")) return `${row.published} local`;
  if (unit.startsWith("count_")) return `${row.published} ${unit.slice("count_".length).replace(/_/g, " ")}`;
  return `${row.published}${unit ? ` ${unit.replace(/_/g, " ")}` : ""}`;
}

function formatModel(value: string | number): string {
  if (typeof value === "number") {
    const rounded = Math.round(value);
    return Math.abs(value - rounded) < 1e-9 ? rounded.toLocaleString("en-US") : value.toFixed(1);
  }
  return value;
}

function ScoreRow({ row, year }: { row: ValidationRow; year: string }) {
  const tuned = row.comparability === "tuned";
  // Time deltas first: they are the comparison itself.
  const fields = [...row.model].sort(
    (a, b) => Number(b.key.includes("delta_min")) - Number(a.key.includes("delta_min")),
  );
  const shown = fields.slice(0, MAX_MODEL_FIELDS);
  const rest = fields.slice(MAX_MODEL_FIELDS);
  return (
    <li className={`rp-score${tuned ? " rp-score--tuned" : ""}`}>
      <div className="rp-score-head">
        <strong>{metricTitle(row.metric)}</strong>
        {row.location && <span className="rp-dim"> · {row.location}</span>}
        <span className={`rp-grade rp-grade--${row.comparability}`}>
          {GRADE_LABEL[row.comparability] ?? row.comparability.replace(/_/g, " ")}
        </span>
      </div>
      <div className="rp-score-cols">
        <div>
          <small>
            {year} published {row.evidenceClass && <EvidenceChip value={row.evidenceClass} />}
          </small>
          <span className="rp-score-value">{formatPublished(row)}</span>
          {row.sourceLocator?.startsWith("http") && (
            <a className="rp-score-src" href={row.sourceLocator.split(";")[0]} target="_blank" rel="noreferrer">
              Source
            </a>
          )}
        </div>
        <div>
          <small>
            Model <EvidenceChip value="simulated" />
          </small>
          <dl className="rp-score-model">
            {shown.map((f) => (
              <div key={f.key}>
                <dt>{humanize(f.key)}</dt>
                <dd>{formatModel(f.value)}</dd>
              </div>
            ))}
          </dl>
          {rest.length > 0 && (
            <details className="rp-score-more">
              <summary>{rest.length} more model fields</summary>
              <dl className="rp-score-model">
                {rest.map((f) => (
                  <div key={f.key}>
                    <dt>{humanize(f.key)}</dt>
                    <dd>{formatModel(f.value)}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
        </div>
      </div>
      {row.caveat && <p className="rp-rule">{row.caveat}</p>}
    </li>
  );
}

/** "Model vs <year>": published figures beside the model's closest output, with how comparable each is. */
export default function ValidationTab({ validation, year }: { validation: Validation; year: string }) {
  const grades = Object.entries(validation.grades);
  return (
    <div className="rp-tab">
      <p className="rp-disclaimer rp-disclaimer--top" role="note">
        Published {year} figures (reconstructions such as NIST&apos;s) beside the model&apos;s closest output. Each row says how
        comparable the two are; none of this is operational guidance. A <strong>tuned</strong> row was used to set a
        model parameter, so agreement there is not validation. Time differences are in minutes; negative means the model
        is earlier than the published time.
      </p>
      {grades.length > 0 && (
        <ul className="rp-grade-key">
          {grades.map(([grade, meaning]) => (
            <li key={grade}>
              <span className={`rp-grade rp-grade--${grade}`}>{GRADE_LABEL[grade] ?? grade}</span> {meaning}
            </li>
          ))}
          {!validation.grades.tuned && validation.rows.some((r) => r.comparability === "tuned") && (
            <li>
              <span className="rp-grade rp-grade--tuned">{GRADE_LABEL.tuned}</span> the model was fitted to this
              figure
            </li>
          )}
        </ul>
      )}
      {validation.rows.length === 0 ? (
        <p className="rp-empty">No comparison rows in this bundle.</p>
      ) : (
        <ul className="rp-scores">
          {validation.rows.map((row) => (
            <ScoreRow key={row.targetId} row={row} year={year} />
          ))}
        </ul>
      )}
    </div>
  );
}
