import MapCanvas from "./MapCanvas";

export default function MapsPage() {
  return (
    <main className="map-page">
      <header className="map-page-header">
        <a className="wordmark" href="/" aria-label="CrisisTwin home">
          <span className="mark" aria-hidden="true">
            CT
          </span>
          CrisisTwin
        </a>
        <span>Map</span>
      </header>
      <MapCanvas />
    </main>
  );
}
