// VoltPass Smartcar connector — Express service.
//
// Flow:  Smartcar Connect OAuth -> this connector -> Smartcar API
//        -> SpacetimeDB persist-only reducers -> live Trip Room updates.
//
// Secrets stay here (server-side env). The frontend only ever calls these routes.

import express from "express";
import cors from "cors";
import {
  connectSpacetime,
  listVehicles,
  vehicleBySmartcarId,
  waitForSmartcarVehicle,
  connectSmartcarVehicle,
  ingestSmartcarSnapshot,
  recordUnlockCommand,
  confirmUnlockStatus,
  approveUnlock,
} from "./spacetime.ts";
import {
  getAuthUrl,
  handleCallback,
  connectSimulator,
  getConnectedVehicles,
  getSnapshot,
  unlock,
  locationConfirmed,
  geofence,
  isConfigured,
  mode,
  type ConnectedVehicle,
} from "./smartcar-connector.ts";

const PORT = Number(process.env.PORT ?? "3001");
const app = express();
app.use(cors());
app.use(express.json());

const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[api]", ...a);

/** Mirror Smartcar-connected vehicles into SpacetimeDB, then wait until the
 * reducer-created rows are visible in our subscription cache. */
async function registerConnected(vehicles: ConnectedVehicle[]) {
  for (const v of vehicles) {
    // label seeds the vehicle's display location until the first live snapshot.
    connectSmartcarVehicle(v.smartcarId, `Tesla ${v.model}`, "Community Garage");
  }
  await Promise.all(vehicles.map((v) => waitForSmartcarVehicle(v.smartcarId)));
}

function joinWithVoltpass(vehicles: ConnectedVehicle[]) {
  return vehicles.map((v) => {
    const vp = vehicleBySmartcarId(v.smartcarId);
    return {
      smartcarId: v.smartcarId,
      make: v.make,
      model: v.model,
      year: v.year,
      voltpassVehicleId: vp ? vp.id.toString() : null,
    };
  });
}

// ---- health / mode --------------------------------------------------------

app.get("/api/smartcar/status", (_req, res) => {
  res.json({
    configured: isConfigured(),
    mode: mode(),
    geofence: geofence(),
    connectedCount: getConnectedVehicles().length,
  });
});

// Alias: /health -> same as /status (for spec compatibility)
app.get("/api/smartcar/health", (_req, res) => {
  res.json({
    configured: isConfigured(),
    mode: mode(),
    geofence: geofence(),
    connectedCount: getConnectedVehicles().length,
  });
});

// 1. Auth URL
app.get("/api/smartcar/auth-url", (_req, res) => {
  const { url, mode: m } = getAuthUrl();
  log(`auth-url requested (mode=${m})`);
  res.json({ url, mode: m });
});

// 2. OAuth callback (code -> tokens -> connected vehicles -> SpacetimeDB)
app.get("/api/smartcar/callback", async (req, res) => {
  const code = String(req.query.code ?? "");
  if (!code) return res.status(400).json({ error: "missing code" });
  try {
    const vehicles = await handleCallback(code);
    await registerConnected(vehicles);
    log(`callback ok: ${vehicles.length} vehicle(s) connected`);
    res.json({ ok: true, vehicles: joinWithVoltpass(vehicles) });
  } catch (err) {
    log("callback error:", (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
});

// Simulator "connect" (no OAuth) — fallback path.
app.post("/api/smartcar/connect-simulator", async (_req, res) => {
  const vehicles = connectSimulator();
  await registerConnected(vehicles);
  log(`simulator connect: ${vehicles.length} vehicle(s)`);
  res.json({ ok: true, vehicles: joinWithVoltpass(vehicles) });
});

// 3. List connected vehicles
app.get("/api/smartcar/vehicles", (_req, res) => {
  res.json({ vehicles: joinWithVoltpass(getConnectedVehicles()) });
});

// 4. Live snapshot -> SpacetimeDB
app.post("/api/smartcar/snapshot", async (req, res) => {
  const { smartcarId, vehicleId, tripId } = req.body ?? {};
  if (!smartcarId || !vehicleId) {
    return res.status(400).json({ error: "smartcarId and vehicleId required" });
  }
  try {
    const snap = await getSnapshot(String(smartcarId));
    const confirmed = locationConfirmed(snap.latitude, snap.longitude);
    ingestSmartcarSnapshot({
      vehicleId: BigInt(vehicleId),
      tripId: tripId ? BigInt(tripId) : 0n,
      source: snap.source,
      batteryPct: snap.batteryPct,
      odometer: snap.odometer,
      latitude: snap.latitude,
      longitude: snap.longitude,
      locationConfirmed: confirmed,
      lockStatus: snap.lockStatus,
      chargeStatus: snap.chargeStatus,
      smartcarVehicleId: String(smartcarId),
    });
    log(`snapshot ${smartcarId} -> ${snap.batteryPct}% conf=${confirmed} (${snap.source})`);
    res.json({ ...snap, locationConfirmed: confirmed, expectedLocation: geofence() });
  } catch (err) {
    log("snapshot error:", (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
});

// 5. Unlock command -> SpacetimeDB (records command, advances trip, confirms)
app.post("/api/smartcar/unlock", async (req, res) => {
  const { smartcarId, vehicleId, tripId, advanceTrip } = req.body ?? {};
  if (!smartcarId || !vehicleId) {
    return res.status(400).json({ error: "smartcarId and vehicleId required" });
  }
  const vId = BigInt(vehicleId);
  const tId = tripId ? BigInt(tripId) : 0n;
  try {
    // Record the command immediately so both windows see "unlock requested".
    recordUnlockCommand(tId, vId, "sent");

    const result = await unlock(String(smartcarId));

    // Advance the trip state machine on unlock (owner approving access),
    // mirroring the simulator "Approve Unlock" path. The reducer itself rejects
    // the call if the trip isn't in VEHICLE_VERIFIED, so this is safe to attempt.
    if (advanceTrip && tId !== 0n) {
      try {
        approveUnlock(tId);
      } catch (e) {
        log("approveUnlock skipped:", (e as Error).message);
      }
    }

    // Confirm the read-back lock status (or leave as "unlocking" if delayed).
    confirmUnlockStatus(tId, vId, result.lockStatus);

    log(`unlock ${smartcarId}: sent=${result.commandSent} status=${result.lockStatus} (${result.source})`);
    res.json(result);
  } catch (err) {
    log("unlock error:", (err as Error).message);
    confirmUnlockStatus(tId, vId, "unknown");
    res.status(500).json({ error: (err as Error).message });
  }
});

// Vehicles known to VoltPass (debug helper)
app.get("/api/voltpass/vehicles", (_req, res) => {
  res.json({
    vehicles: listVehicles().map((v) => ({
      id: v.id.toString(),
      model: v.model,
      battery: v.battery,
      status: v.status,
      source: v.source,
      smartcarVehicleId: v.smartcarVehicleId,
    })),
  });
});

async function main() {
  log(`Smartcar connector starting (mode=${mode()}, configured=${isConfigured()})`);
  await connectSpacetime();
  app.listen(PORT, () => log(`listening on http://127.0.0.1:${PORT}`));
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
