import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import MapsPage from "./maps/MapsPage";
import ReplayView from "./replay/ReplayView";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {window.location.pathname.replace(/\/+$/, "") === "/maps" ? (
      <MapsPage />
    ) : window.location.pathname.replace(/\/+$/, "") === "/replay" ? (
      <ReplayView />
    ) : (
      <App />
    )}
  </StrictMode>,
);
