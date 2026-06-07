// Smartcar connector — the ONLY place that talks to Smartcar.
//
// Uses the real Smartcar SDK when credentials are configured; otherwise (or on
// any API error) falls back to a local simulator so the demo never breaks. The
// Client Secret and access tokens live here, server-side, and are never sent to
// the browser.

import smartcar from "smartcar";

export const SCOPES = [
  "read_vehicle_info",
  "read_battery",
  "read_charge",
  "read_location",
  "read_odometer",
  "read_security",
  "control_security",
];

export interface ConnectedVehicle {
  smartcarId: string;
  make: string;
  model: string;
  year: number;
}

export interface Snapshot {
  batteryPct: number;
  odometer: number;
  latitude: number;
  longitude: number;
  lockStatus: string; // locked | unlocked | unknown
  chargeStatus: string; // charging | not_charging | unknown
  source: "smartcar_live" | "simulator";
}

const CLIENT_ID = process.env.SMARTCAR_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.SMARTCAR_CLIENT_SECRET ?? "";
const REDIRECT_URI = process.env.SMARTCAR_REDIRECT_URI ?? "http://localhost:5173/callback";
const TEST_MODE = (process.env.SMARTCAR_TEST_MODE ?? "false").toLowerCase() === "true";

const GEO_LAT = Number(process.env.VOLTPASS_GEOFENCE_LAT ?? "47.6396");
const GEO_LNG = Number(process.env.VOLTPASS_GEOFENCE_LNG ?? "-122.1284");
const GEO_RADIUS_M = Number(process.env.VOLTPASS_GEOFENCE_RADIUS_M ?? "150");

/** True when real Smartcar credentials are present. */
export const isConfigured = (): boolean => !!CLIENT_ID && !!CLIENT_SECRET;

/** The Smartcar SDK "mode": live cars, Smartcar test cars, or our local sim. */
export const mode = (): "live" | "test" | "simulator" =>
  !isConfigured() ? "simulator" : TEST_MODE ? "test" : "live";

// ---- token + simulator state (in-memory; fine for a local demo) -----------

interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiration: Date;
}
let tokens: TokenSet | null = null;
let connected: ConnectedVehicle[] = [];

// Simulator state per smartcar id.
const SIM_IDS = ["sim-model-x", "sim-model-s-1", "sim-model-s-2"];
const simState: Record<string, { battery: number; lock: string }> = {
  "sim-model-x": { battery: 78, lock: "locked" },
  "sim-model-s-1": { battery: 91, lock: "locked" },
  "sim-model-s-2": { battery: 64, lock: "locked" },
};
const SIM_VEHICLES: ConnectedVehicle[] = [
  { smartcarId: "sim-model-x", make: "TESLA", model: "Model X", year: 2023 },
  { smartcarId: "sim-model-s-1", make: "TESLA", model: "Model S", year: 2022 },
  { smartcarId: "sim-model-s-2", make: "TESLA", model: "Model S", year: 2021 },
];

function authClient() {
  return new smartcar.AuthClient({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    mode: TEST_MODE ? "test" : "live",
  });
}

function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function locationConfirmed(lat: number, lng: number): boolean {
  return distanceMeters(lat, lng, GEO_LAT, GEO_LNG) <= GEO_RADIUS_M;
}

export function geofence() {
  return { lat: GEO_LAT, lng: GEO_LNG, radiusM: GEO_RADIUS_M };
}

// ---- OAuth ----------------------------------------------------------------

export function getAuthUrl(): { url: string; mode: string } {
  if (!isConfigured()) {
    // No creds: hand back a sentinel the frontend treats as "simulator connect".
    return { url: "simulator://connect", mode: "simulator" };
  }
  const url = authClient().getAuthUrl(SCOPES, { forcePrompt: true });
  return { url, mode: TEST_MODE ? "test" : "live" };
}

export async function handleCallback(code: string): Promise<ConnectedVehicle[]> {
  if (!isConfigured()) {
    connected = SIM_VEHICLES;
    return connected;
  }
  const t = await authClient().exchangeCode(code);
  tokens = { accessToken: t.accessToken, refreshToken: t.refreshToken, expiration: t.expiration };

  const { vehicles } = await smartcar.getVehicles(tokens.accessToken);
  const out: ConnectedVehicle[] = [];
  for (const id of vehicles) {
    try {
      const v = new smartcar.Vehicle(id, tokens.accessToken);
      const a: any = await v.attributes();
      out.push({ smartcarId: id, make: a.make ?? "TESLA", model: a.model ?? "Tesla", year: a.year ?? 0 });
    } catch {
      out.push({ smartcarId: id, make: "TESLA", model: "Tesla", year: 0 });
    }
  }
  connected = out;
  return connected;
}

export function connectSimulator(): ConnectedVehicle[] {
  connected = SIM_VEHICLES;
  return connected;
}

export function getConnectedVehicles(): ConnectedVehicle[] {
  return connected;
}

async function freshAccessToken(): Promise<string | null> {
  if (!tokens) return null;
  if (tokens.expiration && new Date(tokens.expiration).getTime() < Date.now() + 60_000) {
    try {
      const t = await authClient().exchangeRefreshToken(tokens.refreshToken);
      tokens = { accessToken: t.accessToken, refreshToken: t.refreshToken, expiration: t.expiration };
    } catch {
      /* keep old token; the call below may still work or fall back */
    }
  }
  return tokens.accessToken;
}

// ---- live snapshot + unlock (with simulator fallback) ---------------------

function simSnapshot(smartcarId: string): Snapshot {
  const s = simState[smartcarId] ?? { battery: 80, lock: "locked" };
  return {
    batteryPct: s.battery,
    odometer: 12044.2,
    latitude: GEO_LAT,
    longitude: GEO_LNG,
    lockStatus: s.lock,
    chargeStatus: "not_charging",
    source: "simulator",
  };
}

export async function getSnapshot(smartcarId: string): Promise<Snapshot> {
  const token = await freshAccessToken();
  if (!isConfigured() || !token || smartcarId.startsWith("sim-")) {
    return simSnapshot(smartcarId);
  }
  try {
    const v = new smartcar.Vehicle(smartcarId, token, { unitSystem: "imperial" });
    const [battery, location, odometer] = await Promise.all([
      v.battery(),
      v.location(),
      v.odometer(),
    ]);
    let lockStatus = "unknown";
    let chargeStatus = "unknown";
    try {
      const ls: any = await v.lockStatus();
      lockStatus = ls?.isLocked ? "locked" : "unlocked";
    } catch {
      /* read_security may be unavailable */
    }
    try {
      const ch: any = await v.charge();
      chargeStatus = ch?.state === "CHARGING" || ch?.isPluggedIn ? "charging" : "not_charging";
    } catch {
      /* optional */
    }
    return {
      batteryPct: Math.round(((battery as any).percentRemaining ?? 0) * 100),
      odometer: (odometer as any).distance ?? 0,
      latitude: (location as any).latitude ?? 0,
      longitude: (location as any).longitude ?? 0,
      lockStatus,
      chargeStatus,
      source: "smartcar_live",
    };
  } catch (err) {
    console.error("[smartcar] snapshot failed, using simulator:", (err as Error).message);
    return simSnapshot(smartcarId);
  }
}

export interface UnlockResult {
  commandSent: boolean;
  lockStatus: string; // post-command read, or "unlocking" if unknown
  source: "smartcar_live" | "simulator";
  message: string;
}

export async function unlock(smartcarId: string): Promise<UnlockResult> {
  const token = await freshAccessToken();
  if (!isConfigured() || !token || smartcarId.startsWith("sim-")) {
    if (simState[smartcarId]) simState[smartcarId].lock = "unlocked";
    return {
      commandSent: true,
      lockStatus: "unlocked",
      source: "simulator",
      message: "Simulated unlock command sent and confirmed.",
    };
  }
  try {
    const v = new smartcar.Vehicle(smartcarId, token);
    await v.unlock();
    let lockStatus = "unlocking";
    try {
      const ls: any = await v.lockStatus();
      lockStatus = ls?.isLocked ? "locked" : "unlocked";
    } catch {
      /* confirmation delayed */
    }
    return {
      commandSent: true,
      lockStatus,
      source: "smartcar_live",
      message: "Unlock command sent to vehicle via Smartcar.",
    };
  } catch (err) {
    console.error("[smartcar] unlock failed:", (err as Error).message);
    return {
      commandSent: false,
      lockStatus: "unknown",
      source: "smartcar_live",
      message: `Unlock failed: ${(err as Error).message}`,
    };
  }
}
