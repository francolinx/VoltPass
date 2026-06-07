// SpacetimeDB bridge for the Smartcar connector.
//
// The connector is just another actor: it holds a SpacetimeDB SDK connection and
// writes Smartcar results back through the persist-only reducers. It never
// embeds business logic in the database.

import { DbConnection } from "../../client/src/module_bindings/index.ts";
import type { Vehicle } from "../../client/src/types.ts";

const URI = process.env.STDB_URI ?? "ws://127.0.0.1:3000";
const MODULE = process.env.VOLTPASS_MODULE ?? "voltpass";

let conn: DbConnection | null = null;
let readyResolve: () => void;
const ready = new Promise<void>((r) => (readyResolve = r));

export function connectSpacetime() {
  DbConnection.builder()
    .withUri(URI)
    .withModuleName(MODULE)
    .onConnect((c, identity) => {
      conn = c;
      console.log(`[stdb] connected to ${URI}/${MODULE} as ${identity.toHexString().slice(0, 12)}`);
      c.subscriptionBuilder()
        .onApplied(() => {
          console.log("[stdb] subscribed");
          readyResolve();
        })
        .subscribe([
          "SELECT * FROM vehicles",
          "SELECT * FROM trips",
          "SELECT * FROM vehicle_snapshots",
        ]);
    })
    .onConnectError((_ctx, err) => console.error("[stdb] connect error:", err.message))
    .onDisconnect(() => console.log("[stdb] disconnected"))
    .build();
  return ready;
}

function db(): DbConnection {
  if (!conn) throw new Error("SpacetimeDB not connected yet");
  return conn;
}

export function listVehicles(): Vehicle[] {
  return [...db().db.vehicles.iter()].sort((a, b) => Number(a.id - b.id));
}

export function vehicleBySmartcarId(smartcarId: string): Vehicle | undefined {
  return [...db().db.vehicles.iter()].find((v) => v.smartcarVehicleId === smartcarId);
}

/** Wait until a reducer-created vehicle is reflected in our subscription cache. */
export async function waitForSmartcarVehicle(
  smartcarId: string,
  timeoutMs = 2000,
): Promise<Vehicle | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = vehicleBySmartcarId(smartcarId);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return vehicleBySmartcarId(smartcarId);
}

export function vehicleById(id: bigint): Vehicle | undefined {
  return [...db().db.vehicles.iter()].find((v) => v.id === id);
}

// ---- persist-only reducer calls -------------------------------------------

export function connectSmartcarVehicle(smartcarVehicleId: string, model: string, label: string) {
  db().reducers.connectSmartcarVehicle({ smartcarVehicleId, model, label });
}

export function ingestSmartcarSnapshot(args: {
  vehicleId: bigint;
  tripId: bigint;
  source: string;
  batteryPct: number;
  odometer: number;
  latitude: number;
  longitude: number;
  locationConfirmed: boolean;
  lockStatus: string;
  chargeStatus: string;
  smartcarVehicleId: string;
}) {
  db().reducers.ingestSmartcarSnapshot(args);
}

export function recordUnlockCommand(tripId: bigint, vehicleId: bigint, commandStatus: string) {
  db().reducers.recordUnlockCommand({ tripId, vehicleId, commandStatus });
}

export function confirmUnlockStatus(tripId: bigint, vehicleId: bigint, lockStatus: string) {
  db().reducers.confirmUnlockStatus({ tripId, vehicleId, lockStatus });
}

export function approveUnlock(tripId: bigint) {
  db().reducers.approveUnlock({ tripId });
}
