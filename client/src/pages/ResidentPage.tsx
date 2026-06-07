import { Link } from "react-router-dom";
import { useVoltPass, activeTrip } from "../hooks";
import { reserveVehicle, startReturn, seedDemoData } from "../store";
import {
  ConnectionPill,
  StatePill,
  VehicleStatus,
  Timeline,
  AiCard,
  DebugStrip,
  Flash,
} from "../components";

const RENTER = "Franco";

export default function ResidentPage() {
  const snap = useVoltPass();
  const trip = activeTrip(snap);

  const model3 = snap.vehicles.find((v) => v.model === "Tesla Model 3");
  const canReserve =
    !!model3 && model3.status === "Available" && (!trip || trip.state === "CLOSED");
  const canReturn = !!trip && trip.state === "TRIP_ACTIVE";

  const tripEvents = trip ? snap.events.filter((e) => e.tripId === trip.id) : [];
  const tripRecs = trip ? snap.recs.filter((r) => r.tripId === trip.id) : [];
  const closeout = tripRecs.find((r) => r.kind === "closeout");

  return (
    <div className="page resident">
      <header className="topbar">
        <div className="brand">
          ⚡ VoltPass <span className="role role-resident">Resident</span>
        </div>
        <div className="top-right">
          <ConnectionPill snap={snap} />
          <Link className="switch-link" to="/owner">
            owner view →
          </Link>
        </div>
      </header>

      <DebugStrip trip={trip} />

      <div className="grid">
        <section className="card span-2">
          <div className="card-head">
            <h2>Your Community Fleet</h2>
            <span className="sub">Microsoft Apartments · resident-only</span>
          </div>
          {model3 && (
            <Flash snap={snap} flashKey={`vehicle-${model3.id}`} className="vehicle-hero">
              <div className="vh-art">🚙⚡</div>
              <div className="vh-info">
                <div className="vh-model">{model3.model}</div>
                <div className="vh-meta">
                  🔋 {model3.battery}% · 📍 {model3.location}
                </div>
                <VehicleStatus status={model3.status} />
              </div>
              <div className="vh-action">
                <button
                  className="btn primary big"
                  disabled={!canReserve || !snap.connected}
                  onClick={() => model3 && reserveVehicle(model3.id, RENTER)}
                >
                  Reserve
                </button>
                <div className="hint">Reserves as {RENTER} (VoltScore 91)</div>
              </div>
            </Flash>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Trip Room</h2>
            <StatePill snap={snap} trip={trip} />
          </div>
          {!trip && <div className="empty">Reserve the Model 3 to open a Trip Room.</div>}
          {trip && (
            <div className="trip-summary">
              <div className="ts-line">
                <span className="dim">Renter</span> <strong>{trip.renter}</strong>
              </div>
              <div className="ts-line">
                <span className="dim">Trip</span> <strong>#{trip.id.toString()}</strong>
              </div>
              {canReturn && (
                <button className="btn warn big" onClick={() => startReturn(trip.id)}>
                  Start Return
                </button>
              )}
              {trip.state === "CLOSED" && <div className="closed-badge">Trip closed ✅</div>}
              {(trip.state === "VEHICLE_VERIFIED" ||
                trip.state === "RESERVED" ||
                trip.state === "CHECK_IN_STARTED") && (
                <div className="waiting">Waiting for owner to approve unlock…</div>
              )}
            </div>
          )}
        </section>

        <section className="card span-2">
          <div className="card-head">
            <h2>AI Trust Agent</h2>
            <span className="sub">writes structured recommendations into SpacetimeDB</span>
          </div>
          {tripRecs.length === 0 && (
            <div className="empty">The AI Trust Agent will post here during check-in.</div>
          )}
          <div className="ai-list">
            {tripRecs.map((r) => (
              <AiCard key={r.id.toString()} snap={snap} rec={r} />
            ))}
          </div>
        </section>

        <section className="card span-2">
          <div className="card-head">
            <h2>Trip Timeline</h2>
            <span className="sub">live from trip_events</span>
          </div>
          <Timeline snap={snap} events={tripEvents} />
        </section>

        {closeout && (
          <section className="card span-2 highlight-card">
            <div className="card-head">
              <h2>Closeout Report</h2>
              <span className="sub">generated from telemetry</span>
            </div>
            <AiCard snap={snap} rec={closeout} />
          </section>
        )}
      </div>

      <footer className="footer">
        <button className="btn ghost" onClick={() => seedDemoData()}>
          ↺ Reset demo
        </button>
      </footer>
    </div>
  );
}
