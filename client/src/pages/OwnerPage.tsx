import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useVoltPass, activeTrip } from "../hooks";
import { approveUnlock, pushTelemetry, seedDemoData } from "../store";
import { useOwnerAgentFallback } from "../ai/useOwnerAgentFallback";
import { SmartcarPanel } from "../SmartcarPanel";
import { smartcar } from "../smartcar-api";
import {
  ConnectionPill,
  StatePill,
  VehicleStatus,
  Timeline,
  AiCard,
  TelemetryPanel,
  DebugStrip,
  Flash,
} from "../components";

// Simulator-backed vehicle connector. Mirrors the shape of Smartcar/Tesla
// telemetry events; streamed through SpacetimeDB one row at a time so both
// windows watch the trip unfold live.
// [battery, odometerDelta, harshBrake, geofenceOk]
const TELEMETRY_SCRIPT: [number, number, boolean, boolean][] = [
  [78, 3.0, false, true],
  [74, 2.5, false, true],
  [70, 3.2, true, true],
  [66, 2.5, false, true],
  [61, 3.0, false, true],
];

export default function OwnerPage() {
  const snap = useVoltPass();
  // Owner window also hosts the AI Trust Agent fallback (writes recommendations
  // through reducers if the standalone agent process isn't running).
  useOwnerAgentFallback(snap);
  const trip = activeTrip(snap);
  const [simulating, setSimulating] = useState(false);
  const timer = useRef<number | null>(null);

  const tripEvents = trip ? snap.events.filter((e) => e.tripId === trip.id) : [];
  const tripRecs = trip ? snap.recs.filter((r) => r.tripId === trip.id) : [];
  const tripTelem = trip ? snap.telemetry.filter((t) => t.tripId === trip.id) : [];

  const canApprove = !!trip && trip.state === "VEHICLE_VERIFIED";
  const canSimulate = !!trip && trip.state === "TRIP_ACTIVE" && !simulating;

  // If the trip's vehicle is Smartcar-connected, the unlock goes through a real
  // Smartcar command; otherwise it's the simulator approve path.
  const tripVehicle = trip ? snap.vehicles.find((v) => v.id === trip.vehicleId) : undefined;
  const isSmartcarVehicle = tripVehicle?.source === "smartcar_live";

  async function doApprove() {
    if (!trip) return;
    if (isSmartcarVehicle && tripVehicle?.smartcarVehicleId) {
      try {
        await smartcar.unlock(
          tripVehicle.smartcarVehicleId,
          tripVehicle.id.toString(),
          trip.id.toString(),
          true,
        );
      } catch (e) {
        console.error("Smartcar unlock failed, falling back to approve:", e);
        approveUnlock(trip.id); // fallback so the demo never stalls
      }
    } else {
      approveUnlock(trip.id);
    }
  }

  const activeTripCount = snap.trips.filter(
    (t) => t.state !== "CLOSED",
  ).length;
  // Vehicles flagged as on a trip in the fleet (includes the seeded Model Y).
  const fleetActive = snap.vehicles.filter((v) => v.status === "Active Trip").length;

  function runSimulation() {
    if (!trip) return;
    setSimulating(true);
    let i = 0;
    const tripId = trip.id;
    const step = () => {
      if (i >= TELEMETRY_SCRIPT.length) {
        if (timer.current) window.clearInterval(timer.current);
        timer.current = null;
        setSimulating(false);
        return;
      }
      const [batt, delta, harsh, geo] = TELEMETRY_SCRIPT[i];
      pushTelemetry(tripId, batt, delta, harsh, geo);
      i++;
    };
    step(); // fire first immediately for instant feedback
    timer.current = window.setInterval(step, 850);
  }

  const incomingVisible =
    !!trip &&
    ["RESERVED", "CHECK_IN_STARTED", "VEHICLE_VERIFIED"].includes(trip.state);

  return (
    <div className="page owner">
      <header className="topbar">
        <div className="brand">
          ⚡ VoltPass <span className="role role-owner">Owner / Community Ops</span>
        </div>
        <div className="top-right">
          <ConnectionPill snap={snap} />
          <Link className="switch-link" to="/resident">
            resident view →
          </Link>
        </div>
      </header>

      <DebugStrip trip={trip} />

      <div className="grid">
        {/* Incoming reservation / approval */}
        <section className={`card span-2 ${incomingVisible ? "highlight-card" : ""}`}>
          <div className="card-head">
            <h2>Incoming Reservation</h2>
            <StatePill snap={snap} trip={trip} />
          </div>
          {!trip || trip.state === "CLOSED" ? (
            <div className="empty">No incoming reservations. Waiting for a resident…</div>
          ) : (
            <Flash snap={snap} flashKey={`trip-${trip.id}`} className="reservation">
              <div className="res-info">
                <div className="res-renter">
                  {trip.renter} <span className="dim">wants</span>{" "}
                  {snap.vehicles.find((v) => v.id === trip.vehicleId)?.model}
                </div>
                <div className="dim">Trip #{trip.id.toString()}</div>
              </div>
              <div className="res-actions">
                {canApprove && (
                  <button className="btn primary big" onClick={doApprove}>
                    {isSmartcarVehicle ? "🔓 Unlock via Smartcar" : "🔓 Approve Unlock"}
                  </button>
                )}
                {trip.state === "TRIP_ACTIVE" && (
                  <button
                    className="btn accent big"
                    disabled={!canSimulate || !snap.connected}
                    onClick={runSimulation}
                  >
                    {simulating ? "Streaming telemetry…" : "▶ Simulate Trip"}
                  </button>
                )}
                {(trip.state === "RETURN_STARTED" || trip.state === "AI_REVIEWING") && (
                  <div className="waiting">AI Trust Agent generating closeout…</div>
                )}
              </div>
            </Flash>
          )}
        </section>

        {/* Smartcar Live Mode */}
        <SmartcarPanel snap={snap} trip={trip} />

        {/* Community Ops */}
        <section className="card community">
          <div className="card-head">
            <h2>Community Ops</h2>
          </div>
          <div className="community-name">{snap.community?.name ?? "Microsoft Apartments"}</div>
          <div className="ops-grid">
            <div className="ops-stat">
              <div className="ops-val">{snap.community?.teslas ?? 3}</div>
              <div className="ops-label">Teslas</div>
            </div>
            <div className="ops-stat">
              <div className="ops-val">{snap.community?.residents ?? 14}</div>
              <div className="ops-label">Verified residents</div>
            </div>
            <div className="ops-stat">
              <div className="ops-val">{snap.community?.chargers ?? 2}</div>
              <div className="ops-label">EV chargers</div>
            </div>
            <div className="ops-stat">
              <div className="ops-val accent">{activeTripCount}</div>
              <div className="ops-label">Active trips</div>
            </div>
          </div>
        </section>

        {/* Fleet status */}
        <section className="card">
          <div className="card-head">
            <h2>Fleet Status</h2>
            <span className="sub">{fleetActive} on trip</span>
          </div>
          <div className="fleet">
            {snap.vehicles.map((v) => (
              <Flash key={v.id.toString()} snap={snap} flashKey={`vehicle-${v.id}`} className="fleet-row">
                <span className="fleet-model">{v.model}</span>
                <span className="fleet-batt">🔋 {v.battery}%</span>
                <VehicleStatus status={v.status} />
              </Flash>
            ))}
          </div>
        </section>

        {/* Telemetry */}
        <section className="card span-2">
          <div className="card-head">
            <h2>Live Telemetry</h2>
            <span className="sub">simulator-backed vehicle connector</span>
          </div>
          <TelemetryPanel snap={snap} rows={tripTelem} />
        </section>

        {/* AI recommendations */}
        <section className="card span-2">
          <div className="card-head">
            <h2>AI Trust Agent</h2>
            <span className="sub">structured recommendations in SpacetimeDB</span>
          </div>
          {tripRecs.length === 0 && <div className="empty">No AI recommendations yet.</div>}
          <div className="ai-list">
            {tripRecs.map((r) => (
              <AiCard key={r.id.toString()} snap={snap} rec={r} />
            ))}
          </div>
        </section>

        {/* Timeline */}
        <section className="card span-2">
          <div className="card-head">
            <h2>Event Timeline</h2>
            <span className="sub">live from trip_events</span>
          </div>
          <Timeline snap={snap} events={tripEvents} />
        </section>
      </div>

      <footer className="footer">
        <button className="btn ghost" onClick={() => seedDemoData()}>
          ↺ Reset demo
        </button>
      </footer>
    </div>
  );
}
