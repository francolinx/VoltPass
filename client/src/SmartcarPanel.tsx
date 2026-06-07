import { useEffect, useState } from "react";
import {
  smartcar,
  type ConnectedVehicle,
  type SmartcarStatus,
  type SnapshotResult,
} from "./smartcar-api";
import type { Snapshot } from "./store";
import type { Trip } from "./types";

// "Smartcar Live Mode" — owner panel. Connect real Teslas via Smartcar, pull a
// live snapshot (SOC/GPS/parked/lock) into SpacetimeDB, and unlock via Smartcar.
// Falls back to the local simulator if Smartcar isn't configured or fails.
export function SmartcarPanel({ snap, trip }: { snap: Snapshot; trip: Trip | null }) {
  const [status, setStatus] = useState<SmartcarStatus | null>(null);
  const [vehicles, setVehicles] = useState<ConnectedVehicle[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [snapResult, setSnapResult] = useState<SnapshotResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const [st, vs] = await Promise.all([smartcar.status(), smartcar.vehicles()]);
      setStatus(st);
      setVehicles(vs.vehicles);
      if (!selected && vs.vehicles[0]) setSelected(vs.vehicles[0].smartcarId);
    } catch (e) {
      setError(`Connector offline: ${(e as Error).message}. Start the api/ service.`);
    }
  }

  useEffect(() => {
    refresh();
    // If we just returned from the OAuth callback, refresh the list.
    const p = new URLSearchParams(window.location.search);
    if (p.get("smartcar") === "connected") refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sel = vehicles.find((v) => v.smartcarId === selected) ?? null;

  async function connect() {
    setError(null);
    setBusy("connect");
    try {
      const { url, mode } = await smartcar.authUrl();
      if (mode === "simulator" || url.startsWith("simulator://")) {
        const res = await smartcar.connectSimulator();
        setVehicles(res.vehicles);
        if (res.vehicles[0]) setSelected(res.vehicles[0].smartcarId);
        await refresh();
      } else {
        window.location.href = url; // real Smartcar Connect (Tesla auth)
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function pullSnapshot() {
    if (!sel?.voltpassVehicleId) return;
    setError(null);
    setBusy("snapshot");
    try {
      const r = await smartcar.snapshot(
        sel.smartcarId,
        sel.voltpassVehicleId,
        trip ? trip.id.toString() : undefined,
      );
      setSnapResult(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function unlockViaSmartcar() {
    if (!sel?.voltpassVehicleId) return;
    setError(null);
    setBusy("unlock");
    try {
      await smartcar.unlock(
        sel.smartcarId,
        sel.voltpassVehicleId,
        trip ? trip.id.toString() : undefined,
        true,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // Live vehicle row mirror (so the panel reflects SpacetimeDB state too).
  const liveVehicle = sel?.voltpassVehicleId
    ? snap.vehicles.find((v) => v.id.toString() === sel.voltpassVehicleId)
    : undefined;

  return (
    <section className="card span-2 smartcar-card">
      <div className="card-head">
        <h2>🛰️ Smartcar Live Mode</h2>
        <span className={`sc-mode ${status?.mode ?? ""}`}>
          {status ? `mode: ${status.mode}${status.configured ? "" : " (no creds → simulator)"}` : "…"}
        </span>
      </div>

      {error && <div className="sc-error">{error}</div>}

      {vehicles.length === 0 ? (
        <div className="sc-connect">
          <p className="muted">
            Connect your Teslas through Smartcar to power the trip with real
            state-of-charge, GPS, parked-location confirmation and remote unlock.
          </p>
          <button className="btn primary big" disabled={busy === "connect"} onClick={connect}>
            {busy === "connect" ? "Connecting…" : "🔗 Connect Smartcar"}
          </button>
        </div>
      ) : (
        <div className="sc-body">
          <div className="sc-vehicles">
            {vehicles.map((v) => (
              <button
                key={v.smartcarId}
                className={`sc-vehicle ${selected === v.smartcarId ? "active" : ""}`}
                onClick={() => {
                  setSelected(v.smartcarId);
                  setSnapResult(null);
                }}
              >
                <span>🚙 {v.make} {v.model}</span>
                <span className="dim">{v.year || ""}</span>
              </button>
            ))}
          </div>

          <div className="sc-actions">
            <button
              className="btn accent"
              disabled={!sel?.voltpassVehicleId || busy === "snapshot"}
              onClick={pullSnapshot}
            >
              {busy === "snapshot" ? "Pulling…" : "📡 Pull Live Snapshot"}
            </button>
            <button
              className="btn primary"
              disabled={!sel?.voltpassVehicleId || busy === "unlock"}
              onClick={unlockViaSmartcar}
            >
              {busy === "unlock" ? "Unlocking…" : "🔓 Unlock via Smartcar"}
            </button>
            <button className="btn ghost" onClick={refresh}>↺ Refresh</button>
          </div>

          {(snapResult || liveVehicle) && (
            <div className="sc-snapshot">
              <div className="sc-stat">
                <div className="stat-val">
                  {snapResult?.batteryPct ?? liveVehicle?.battery ?? "—"}%
                </div>
                <div className="stat-label">State of charge</div>
              </div>
              <div className="sc-stat">
                <div className="stat-val small">
                  {(snapResult?.latitude ?? liveVehicle?.latitude ?? 0).toFixed(4)},
                  {(snapResult?.longitude ?? liveVehicle?.longitude ?? 0).toFixed(4)}
                </div>
                <div className="stat-label">GPS</div>
              </div>
              <div className="sc-stat">
                <div
                  className={`stat-val small ${
                    (snapResult?.locationConfirmed ?? liveVehicle?.locationConfirmed)
                      ? "good"
                      : "warn"
                  }`}
                >
                  {(snapResult?.locationConfirmed ?? liveVehicle?.locationConfirmed)
                    ? "✓ confirmed"
                    : "⚠ off-site"}
                </div>
                <div className="stat-label">Parked where expected</div>
              </div>
              <div className="sc-stat">
                <div className="stat-val small">
                  {snapResult?.lockStatus ?? liveVehicle?.lockStatus ?? "—"}
                </div>
                <div className="stat-label">Lock status</div>
              </div>
              {snapResult && (
                <div className="sc-source">
                  source: <strong>{snapResult.source}</strong>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
