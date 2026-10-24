import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import FireSimulatorPage from "./fire/FireSimulatorPage";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {window.location.pathname.replace(/\/+$/, "") === "/fire" ? <FireSimulatorPage /> : <App />}
  </StrictMode>,
);
