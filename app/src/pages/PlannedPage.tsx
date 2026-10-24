import type { PlannedPageDefinition } from "../navigation";

export default function PlannedPage({ page }: { page: PlannedPageDefinition }) {
  return (
    <main className="planning-page" id="main-content" tabIndex={-1}>
      <header className="planning-header">
        <p className="eyebrow">{page.group}</p>
        <h1>{page.label}</h1>
        <p className="description">{page.description}</p>
      </header>
      <section className="planning-empty" aria-labelledby="empty-title">
        <span className="badge">Planned feature</span>
        <h2 id="empty-title">{page.emptyTitle}</h2>
        <p>{page.emptyDescription}</p>
        <a className="action-link" href="/maps">
          Explore the map &amp; fire demo →
        </a>
      </section>
      <section className="planned-capabilities" aria-labelledby="capabilities-title">
        <h2 id="capabilities-title">Planned for this workspace</h2>
        <ul>
          {page.plannedCapabilities.map((capability) => (
            <li key={capability}>{capability}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
