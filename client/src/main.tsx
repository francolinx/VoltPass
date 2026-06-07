import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate, Link } from "react-router-dom";
import ResidentPage from "./pages/ResidentPage";
import OwnerPage from "./pages/OwnerPage";
import "./styles.css";

function Landing() {
  return (
    <div className="landing">
      <div className="landing-card">
        <div className="brand-big">⚡ VoltPass</div>
        <p className="tagline">Real-time Trust OS for resident-only EV sharing</p>
        <p className="muted">
          Open both windows side by side. An action in one updates the other
          instantly through SpacetimeDB.
        </p>
        <div className="landing-links">
          <Link className="btn primary" to="/resident">
            Open /resident
          </Link>
          <Link className="btn" to="/owner">
            Open /owner
          </Link>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/resident" element={<ResidentPage />} />
        <Route path="/owner" element={<OwnerPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
