import { useId } from "react";
import { Button, Field, SegmentedControl, type SegmentedOption } from "../../ui";
import { gustFactorOf, type StochasticSpreadOptions } from "../stochastic";
import type { ScenarioWindRecord } from "../scenarioWeather";
import "./naturalVariation.css";

/** Seed a fresh scenario starts with. Any finite number works; the user can change it. */
export const DEFAULT_VARIATION_SEED = 1;
const MAX_SEED = 2_147_483_647;

const MODE_OPTIONS: SegmentedOption<"off" | "on">[] = [
  { value: "off", label: "Off", title: "One fixed, repeatable fire" },
  { value: "on", label: "On", title: "One seeded, slightly different fire" },
];

/** Hourly peak gust over mean wind at the hour the run's wind was taken from; null when unobserved. */
export function observedGustFactor(record: ScenarioWindRecord | null | undefined): number | null {
  if (!record) return null;
  const sample = record.series.find((entry) => entry.tUtc === record.applied.tUtc);
  return sample ? gustFactorOf(sample) : null;
}

/** A random whole-number seed for the "New seed" button. User-triggered, shown, and reproducible. */
export function newVariationSeed(): number {
  return 1 + Math.floor(Math.random() * 999_999);
}

export interface NaturalVariationControlProps {
  value: StochasticSpreadOptions | undefined;
  onChange: (next: StochasticSpreadOptions | undefined) => void;
  /** Observed gust factor from the run's weather, or null/undefined to use the model default. */
  gustFactor?: number | null;
  /** False when ember spotting is switched off elsewhere, so the sub-toggle cannot do anything. */
  spottingAvailable?: boolean;
  /** Distinct DOM ids when two controls could share a page. */
  idPrefix?: string;
  className?: string;
}

/**
 * "Natural variation": seeded stochastic fire spread (stochastic.ts). Off keeps the
 * deterministic solver. Output of a run with it on is simulated, not a forecast.
 */
export default function NaturalVariationControl({
  value,
  onChange,
  gustFactor = null,
  spottingAvailable = true,
  idPrefix,
  className,
}: NaturalVariationControlProps) {
  const reactId = useId();
  const uid = idPrefix ?? reactId;
  const enabled = value?.enabled === true;
  const seed = value?.seed ?? DEFAULT_VARIATION_SEED;

  function emit(patch: Partial<StochasticSpreadOptions>) {
    onChange({ enabled, seed, ...value, gustFactor, ...patch });
  }

  const uneven = value?.rosSigma !== 0;
  const gusts = value?.windWander !== false;
  const embers = value?.spotting !== false;

  return (
    <div className={["fr-nv", className].filter(Boolean).join(" ")}>
      <div className="fr-nv-head">
        <span className="fr-nv-title">Natural variation</span>
        <SegmentedControl
          label="Natural variation"
          options={MODE_OPTIONS}
          value={enabled ? "on" : "off"}
          onChange={(next) => emit({ enabled: next === "on" })}
        />
      </div>
      <p className="fr-nv-help">
        {enabled
          ? "One possible fire. The same seed gives the same fire every time."
          : "Off: one fixed fire from the average conditions."}
      </p>
      {enabled && (
        <>
          <div className="fr-nv-seed">
            <Field label="Seed" hint="Same seed, same fire">
              <input
                id={`${uid}-seed`}
                type="number"
                className="ui-input"
                min={0}
                max={MAX_SEED}
                step={1}
                value={seed}
                onChange={(event) => {
                  const next = event.target.valueAsNumber;
                  if (Number.isFinite(next)) {
                    emit({ seed: Math.min(MAX_SEED, Math.max(0, Math.round(next))) });
                  }
                }}
              />
            </Field>
            <Button variant="secondary" size="sm" onClick={() => emit({ seed: newVariationSeed() })}>
              New seed
            </Button>
          </div>
          <details className="fr-nv-details">
            <summary>What varies</summary>
            <div className="fr-nv-toggles">
              <label className="ui-check">
                <input
                  type="checkbox"
                  checked={uneven}
                  onChange={(event) => emit({ rosSigma: event.target.checked ? undefined : 0 })}
                />
                Uneven spread
              </label>
              <p className="fr-nv-help">Fuel and moisture patches make the fire faster or slower in places.</p>
              <label className="ui-check">
                <input
                  type="checkbox"
                  checked={gusts}
                  onChange={(event) => emit({ windWander: event.target.checked })}
                />
                Wind gusts and shifts
              </label>
              <p className="fr-nv-help">
                The wind speeds up, slows down and swings a little.
                {gustFactor !== null ? " Sized from the observed gusts." : " Sized from typical gustiness."}
              </p>
              <label className="ui-check">
                <input
                  type="checkbox"
                  checked={embers && spottingAvailable}
                  disabled={!spottingAvailable}
                  onChange={(event) => emit({ spotting: event.target.checked })}
                />
                Ember spot fires
              </label>
              <p className="fr-nv-help">
                {spottingAvailable
                  ? "Embers can land ahead of the fire and start new fires."
                  : "Turn on ember spotting first."}
              </p>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
