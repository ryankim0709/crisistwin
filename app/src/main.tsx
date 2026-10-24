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
    <AppShell path={path}>{page}</AppShell>
  </StrictMode>,
);
