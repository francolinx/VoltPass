// Thin client for the VoltPass Smartcar connector (server-side). The browser
// never sees Smartcar secrets or tokens — only these endpoints.

export interface ConnectedVehicle {
  smartcarId: string;
  make: string;
  model: string;
  year: number;
  voltpassVehicleId: string | null;
}

export interface SmartcarStatus {
  configured: boolean;
  mode: "live" | "test" | "simulator";
  geofence: { lat: number; lng: number; radiusM: number };
  connectedCount: number;
}

export interface SnapshotResult {
  batteryPct: number;
  odometer: number;
  latitude: number;
  longitude: number;
  lockStatus: string;
  chargeStatus: string;
  source: "smartcar_live" | "simulator";
  locationConfirmed: boolean;
  expectedLocation: { lat: number; lng: number; radiusM: number };
}

export interface UnlockResult {
  commandSent: boolean;
  lockStatus: string;
  source: "smartcar_live" | "simulator";
  message: string;
}

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `GET ${url} failed`);
  return r.json();
}
async function jpost<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `POST ${url} failed`);
  return r.json();
}

export const smartcar = {
  status: () => jget<SmartcarStatus>("/api/smartcar/status"),
  authUrl: () => jget<{ url: string; mode: string }>("/api/smartcar/auth-url"),
  callback: (code: string) =>
    jget<{ ok: boolean; vehicles: ConnectedVehicle[] }>(
      `/api/smartcar/callback?code=${encodeURIComponent(code)}`,
    ),
  connectSimulator: () =>
    jpost<{ ok: boolean; vehicles: ConnectedVehicle[] }>("/api/smartcar/connect-simulator"),
  vehicles: () => jget<{ vehicles: ConnectedVehicle[] }>("/api/smartcar/vehicles"),
  snapshot: (smartcarId: string, vehicleId: string, tripId?: string) =>
    jpost<SnapshotResult>("/api/smartcar/snapshot", { smartcarId, vehicleId, tripId }),
  unlock: (smartcarId: string, vehicleId: string, tripId?: string, advanceTrip = true) =>
    jpost<UnlockResult>("/api/smartcar/unlock", { smartcarId, vehicleId, tripId, advanceTrip }),
};
