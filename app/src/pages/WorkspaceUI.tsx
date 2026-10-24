import type { ReactNode } from "react";

export function WorkspacePage({
  title,
  description,
  section = "Workspace",
  action,
  children,
}: {
  title: string;
  description: string;
  section?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="workspace-page" id="main-content" tabIndex={-1}>
      <header className="workspace-heading">
        <div>
          <p className="eyebrow">{section} / CrisisTwin</p>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        {action}
      </header>
      {children}
      <footer>
        Experimental planning only. Outputs are not operational evacuation instructions.
      </footer>
    </main>
  );
}

export function Panel({
  title,
  eyebrow,
  aside,
  children,
}: {
  title: string;
  eyebrow?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="ui-panel">
      <div className="panel-heading">
        <div>
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h2>{title}</h2>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Tag({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "green" | "amber";
}) {
  return <span className={`ui-tag ui-tag-${tone}`}>{children}</span>;
}

export function DraftNotice() {
  return (
    <p className="ui-notice">
      <strong>UI preview</strong> Sample inputs are editable on this page. Drafts reset when you
      leave or reload; saving and simulation services are not connected.
    </p>
  );
}

export function EmptyResult({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="ui-empty">
      <span className="empty-symbol" aria-hidden="true">
        ↗
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="ui-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="ui-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}
