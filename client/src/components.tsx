import React from "react";
import { useFlash, fmtTime } from "./hooks";
import type { Snapshot } from "./store";
import type { Trip, TripEvent, Telemetry, AiRecommendation } from "./types";

// ---- Connection indicator -------------------------------------------------

export function ConnectionPill({ snap }: { snap: Snapshot }) {
  return (
    <div className={`conn-pill ${snap.connected ? "ok" : "bad"}`}>
      <span className="dot" />
      {snap.connected ? "SpacetimeDB connected" : "Connecting to SpacetimeDB…"}
    </div>
  );
}

// ---- State pill -----------------------------------------------------------

const STATE_LABELS: Record<string, string> = {
  RESERVED: "Reserved",
  CHECK_IN_STARTED: "Check-in started",
  VEHICLE_VERIFIED: "Vehicle verified",
  UNLOCK_GRANTED: "Unlock granted",
  TRIP_ACTIVE: "Trip active",
  RETURN_STARTED: "Return started",
  AI_REVIEWING: "AI reviewing",
  CLOSED: "Closed",
};

export function StatePill({ snap, trip }: { snap: Snapshot; trip: Trip | null }) {
  const flashing = useFlash(snap, trip ? `trip-state-${trip.id}` : "none");
  if (!trip) return <span className="state-pill idle">No active trip</span>;
  const cls = trip.state.toLowerCase().replace(/_/g, "-");
  return (
    <span className={`state-pill ${cls} ${flashing ? "flash" : ""}`}>
      {STATE_LABELS[trip.state] ?? trip.state}
    </span>
  );
}

// ---- Status pill (vehicle) -----------------------------------------------

export function VehicleStatus({ status }: { status: string }) {
  const cls = status.toLowerCase().replace(/\s+/g, "-");
  return <span className={`status-pill ${cls}`}>{status}</span>;
}

// ---- Flash wrapper --------------------------------------------------------

export function Flash({
  snap,
  flashKey,
  className,
  children,
}: {
  snap: Snapshot;
  flashKey: string;
  className?: string;
  children: React.ReactNode;
}) {
  const on = useFlash(snap, flashKey);
  return <div className={`${className ?? ""} ${on ? "row-flash" : ""}`}>{children}</div>;
}

// ---- Event timeline -------------------------------------------------------

const EVENT_ICONS: Record<string, string> = {
  RESERVED: "📝",
  CHECK_IN_STARTED: "🔑",
  VEHICLE_VERIFIED: "📸",
  AI_UNLOCK_RECOMMENDATION: "🤖",
  UNLOCK_GRANTED: "🔓",
  TRIP_ACTIVE: "🚗",
  TELEMETRY: "📡",
  RETURN_STARTED: "↩️",
  AI_REVIEWING: "🤖",
  AI_CLOSEOUT: "📄",
  CLOSED: "✅",
};

export function Timeline({ snap, events }: { snap: Snapshot; events: TripEvent[] }) {
  if (events.length === 0) {
    return <div className="empty">No events yet. Reserve a vehicle to start the Trip Room.</div>;
  }
  return (
    <div className="timeline">
      {[...events].reverse().map((e) => (
        <Flash key={e.id.toString()} snap={snap} flashKey={`event-${e.id}`} className="timeline-row">
          <span className="tl-icon">{EVENT_ICONS[e.kind] ?? "•"}</span>
          <div className="tl-body">
            <div className="tl-kind">{e.kind.replace(/_/g, " ")}</div>
            <div className="tl-payload">{e.payload}</div>
          </div>
          <span className="tl-time">{fmtTime(e.timestamp)}</span>
        </Flash>
      ))}
    </div>
  );
}

// ---- AI recommendation card ----------------------------------------------

export function AiCard({ snap, rec }: { snap: Snapshot; rec: AiRecommendation }) {
  const verdictClass = rec.verdict.toLowerCase().replace(/_/g, "-");
  const title = rec.kind === "unlock" ? "AI Unlock Recommendation" : "AI Closeout Report";
  return (
    <Flash snap={snap} flashKey={`rec-${rec.id}`} className={`ai-card ${verdictClass}`}>
      <div className="ai-head">
        <span className="ai-robot">🤖</span>
        <span className="ai-title">{title}</span>
        <span className={`verdict ${verdictClass}`}>{rec.verdict.replace(/_/g, " ")}</span>
      </div>
      <div className="ai-body">{rec.body}</div>
      <div className="ai-foot">AI Trust Agent · written into SpacetimeDB</div>
    </Flash>
  );
}

// ---- Telemetry panel ------------------------------------------------------

export function TelemetryPanel({ snap, rows }: { snap: Snapshot; rows: Telemetry[] }) {
  if (rows.length === 0) {
    return <div className="empty">No telemetry yet.</div>;
  }
  const latest = rows[rows.length - 1];
  const totalMiles = rows.reduce((a, r) => a + r.odometerDelta, 0);
  const harsh = rows.filter((r) => r.harshBrake).length;
  return (
    <div>
      <div className="telem-stats">
        <Flash snap={snap} flashKey="telemetry-latest" className="telem-stat">
          <div className="stat-val">{latest.battery}%</div>
          <div className="stat-label">Battery</div>
        </Flash>
        <Flash snap={snap} flashKey="telemetry-latest" className="telem-stat">
          <div className="stat-val">+{totalMiles.toFixed(1)}</div>
          <div className="stat-label">Miles</div>
        </Flash>
        <div className="telem-stat">
          <div className={`stat-val ${harsh > 0 ? "warn" : ""}`}>{harsh}</div>
          <div className="stat-label">Harsh brakes</div>
        </div>
        <div className="telem-stat">
          <div className={`stat-val ${rows.every((r) => r.geofenceOk) ? "good" : "warn"}`}>
            {rows.every((r) => r.geofenceOk) ? "OK" : "⚠"}
          </div>
          <div className="stat-label">Geofence</div>
        </div>
      </div>
      <div className="telem-rows">
        {[...rows].reverse().map((r) => (
          <Flash key={r.id.toString()} snap={snap} flashKey={`telemetry-${r.id}`} className="telem-row">
            <span>🔋 {r.battery}%</span>
            <span>+{r.odometerDelta.toFixed(1)} mi</span>
            <span className={r.harshBrake ? "warn" : "dim"}>
              {r.harshBrake ? "⚠ harsh brake" : "smooth"}
            </span>
            <span className={r.geofenceOk ? "good" : "warn"}>
              {r.geofenceOk ? "geofence ok" : "geofence breach"}
            </span>
            <span className="tl-time">{fmtTime(r.timestamp)}</span>
          </Flash>
        ))}
      </div>
    </div>
  );
}

// ---- Debug strip (live current trip row) ----------------------------------

export function DebugStrip({ trip }: { trip: Trip | null }) {
  if (!trip) return <div className="debug-strip">trips: (empty) — waiting for reserve_vehicle</div>;
  return (
    <div className="debug-strip">
      <strong>live trips row</strong> → id={trip.id.toString()} vehicle_id=
      {trip.vehicleId.toString()} renter="{trip.renter}" <span className="db-state">state={trip.state}</span>
    </div>
  );
}
