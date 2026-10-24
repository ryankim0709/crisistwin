export default function NotFoundPage() {
  return (
    <main className="planning-page" id="main-content" tabIndex={-1}>
      <header className="planning-header">
        <p className="eyebrow">Page not found</p>
        <h1>This page isn’t here.</h1>
        <p className="description">
          Choose a workspace from the sidebar or return to the overview.
        </p>
      </header>
      <a className="action-link" href="/">
        Back to overview →
      </a>
    </main>
  );
}
