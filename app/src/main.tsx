import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import AppShell from "./AppShell";
import MapsPage from "./maps/MapsPage";
import ScenariosPage from "./pages/ScenariosPage";
import EvacuationPage from "./pages/EvacuationPage";
import ComparisonPage from "./pages/ComparisonPage";
import IncidentsPage from "./pages/IncidentsPage";
import StressTestsPage from "./pages/StressTestsPage";
import NotFoundPage from "./pages/NotFoundPage";
import { SIMULATION_VIEW } from "./replay/loadBundle";
import ReplayView from "./replay/ReplayView";
import ReplayRoute from "./replay/IncidentPicker";
import "./index.css";
import "./pages/workspace.css";

const path = window.location.pathname.replace(/\/+$/, "") || "/";
const page =
  path === "/" ? (
    <App />
  ) : path === "/maps" ? (
    <MapsPage />
  ) : path === "/scenarios" ? (
    <ScenariosPage />
  ) : path === "/evacuation" ? (
    <EvacuationPage />
  ) : path === "/comparison" ? (
    <ComparisonPage />
  ) : path === "/incidents" ? (
    <IncidentsPage />
  ) : path === "/stress-tests" ? (
    <StressTestsPage />
  ) : (
    <NotFoundPage />
  );

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* The replay views are full-viewport map tools with their own navigation, so they
        render outside the shell; every other page uses the shared sidebar shell. */}
    {path === "/replay" ? (
      <ReplayRoute />
    ) : path === "/simulate" ? (
      <ReplayView config={SIMULATION_VIEW} />
    ) : (
      <AppShell path={path}>{page}</AppShell>
    )}
  </StrictMode>,
);
