import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Design system first, so feature stylesheets (imported by the pages below) can override
// kit classes at equal specificity.
import "./index.css";
import "./pages/workspace.css";
import AppShell from "./AppShell";
import FireSimulatorPage from "./fire/FireSimulatorPage";
import SimulationStudioPage from "./studio/SimulationStudioPage";
import DispatchAgentPage from "./dispatch/DispatchAgentPage";
import ScenariosPage from "./pages/ScenariosPage";
import EvacuationPage from "./pages/EvacuationPage";
import ComparisonPage from "./pages/ComparisonPage";
import IntelPage from "./pages/IntelPage";
import StressTestsPage from "./pages/StressTestsPage";
import NotFoundPage from "./pages/NotFoundPage";
import DioramaPage from "./diorama/DioramaPage";
import { SIMULATION_VIEW } from "./replay/loadBundle";
import ReplayView from "./replay/ReplayView";
import ReplayRoute from "./replay/IncidentPicker";
import LiveCommandPage from "./live/LiveCommandPage";

// The workspace has no landing page; the root opens the fire spread model.
if (window.location.pathname === "/")
  window.history.replaceState(null, "", "/fire" + window.location.search + window.location.hash);
// /incidents was merged into /intel; keep old links working.
if (/^\/incidents\/*$/.test(window.location.pathname))
  window.history.replaceState(null, "", "/intel" + window.location.search + window.location.hash);
const path = window.location.pathname.replace(/\/+$/, "") || "/";
const page =
  path === "/fire" ? (
    <FireSimulatorPage />
  ) : path === "/simulation" ? (
    <SimulationStudioPage />
  ) : path === "/dispatch" ? (
    <DispatchAgentPage />
  ) : path === "/scenarios" ? (
    <ScenariosPage />
  ) : path === "/evacuation" ? (
    <EvacuationPage />
  ) : path === "/comparison" ? (
    <ComparisonPage />
  ) : path === "/intel" ? (
    <IntelPage />
  ) : path === "/stress-tests" ? (
    <StressTestsPage />
  ) : path === "/replay" ? (
    <ReplayRoute />
  ) : path === "/simulate" ? (
    <ReplayView config={SIMULATION_VIEW} />
  ) : path === "/diorama" ? (
    <DioramaPage />
  ) : (
    <NotFoundPage />
  );

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* Live command is a full-viewport map tool with its own navigation. */}
    {path === "/live" ? <LiveCommandPage /> : <AppShell path={path}>{page}</AppShell>}
  </StrictMode>,
);
