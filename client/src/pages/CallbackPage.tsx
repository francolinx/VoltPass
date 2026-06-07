import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { smartcar } from "../smartcar-api";

// Smartcar redirects here (SMARTCAR_REDIRECT_URI=http://localhost:5173/callback).
// We forward the auth code to the server-side connector, which exchanges it for
// tokens (kept server-side) and registers the vehicles into SpacetimeDB.
export default function CallbackPage() {
  const nav = useNavigate();
  const [msg, setMsg] = useState("Connecting your Tesla through Smartcar…");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const err = params.get("error");
    if (err) {
      setError(`Smartcar authorization failed: ${err}`);
      return;
    }
    if (!code) {
      setError("No authorization code returned from Smartcar.");
      return;
    }
    smartcar
      .callback(code)
      .then((res) => {
        setMsg(`Connected ${res.vehicles.length} vehicle(s). Returning to owner view…`);
        setTimeout(() => nav("/owner?smartcar=connected"), 900);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, [nav]);

  return (
    <div className="landing">
      <div className="landing-card">
        <div className="brand-big">⚡ VoltPass</div>
        {!error ? (
          <>
            <p className="tagline">{msg}</p>
            <p className="muted">Exchanging your Smartcar authorization securely on the server…</p>
          </>
        ) : (
          <>
            <p className="tagline" style={{ color: "#f59e0b" }}>
              {error}
            </p>
            <button className="btn primary" onClick={() => nav("/owner")}>
              Back to owner view
            </button>
          </>
        )}
      </div>
    </div>
  );
}
