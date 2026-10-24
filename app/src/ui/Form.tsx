import type { ReactNode } from "react";

/** Labelled control. Wrap any input/select/textarea; `hint` renders under the label. */
export function Field({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="ui-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

/** Groups related radios/checkboxes under a visible legend. */
export function Fieldset({ legend, children }: { legend: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="ui-fieldset">
      <legend>{legend}</legend>
      {children}
    </fieldset>
  );
}
