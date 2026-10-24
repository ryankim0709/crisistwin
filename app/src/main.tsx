import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import AppShell from "./AppShell";
import MapsPage from "./maps/MapsPage";
import { plannedPages } from "./navigation";
import PlannedPage from "./pages/PlannedPage";
import NotFoundPage from "./pages/NotFoundPage";
import "./index.css";

const path = window.location.pathname.replace(/\/+$/, "") || "/";
const plannedPage = plannedPages.find((page) => page.path === path);
const page =
  path === "/" ? (
    <App />
  ) : path === "/maps" ? (
    <MapsPage />
  ) : plannedPage ? (
    <PlannedPage page={plannedPage} />
  ) : (
    <NotFoundPage />
  );

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppShell path={path}>
      {page}
    </AppShell>
  </StrictMode>,
);
