// VoltPass live store.
//
// This is the bridge between SpacetimeDB and React. It opens a single
// DbConnection, subscribes to every public table, and republishes the cached
// rows into a plain immutable snapshot that React reads via useSyncExternalStore.
//
// Every row that changes also records a "flash" timestamp so the UI can pulse a
// highlight — this is what makes the live sync between /resident and /owner
// visually obvious to a judge within seconds.

import { DbConnection, type EventContext } from "./module_bindings";
import { Identity } from "spacetimedb";
import type {
  Vehicle,
  Resident,
  Trip,
  TripEvent,
  Telemetry,
  AiRecommendation,
  Community,
} from "./types";

export type Snapshot = {
  connected: boolean;
  identity: string | null;
  vehicles: Vehicle[];
  residents: Resident[];
  trips: Trip[];
  events: TripEvent[];
  telemetry: Telemetry[];
  recs: AiRecommendation[];
  community: Community | null;
  /** Map of "flash key" -> epoch ms when it last changed. */
  flashes: Record<string, number>;
  /** Monotonic version, bumped on every change. */
  version: number;
};

const MODULE_NAME = "voltpass";

function wsUri(): string {
  // Allow overriding via ?stdb=ws://host:port ; otherwise default to the
  // SpacetimeDB instance on the same host, port 3000.
  const params = new URLSearchParams(window.location.search);
  const override = params.get("stdb");
  if (override) return override;
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.hostname}:3000`;
}

let snapshot: Snapshot = {
  connected: false,
  identity: null,
  vehicles: [],
  residents: [],
  trips: [],
  events: [],
  telemetry: [],
  recs: [],
  community: null,
  flashes: {},
  version: 0,
};

const listeners = new Set<() => void>();
let conn: DbConnection | null = null;
let started = false;

function emit() {
  for (const l of listeners) l();
}

function flash(key: string) {
  snapshot = {
    ...snapshot,
    flashes: { ...snapshot.flashes, [key]: Date.now() },
  };
}

function rebuild(partial: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...partial, version: snapshot.version + 1 };
  emit();
}

function refreshVehicles() {
  rebuild({ vehicles: [...conn!.db.vehicles.iter()].sort((a, b) => Number(a.id - b.id)) });
}
function refreshResidents() {
  rebuild({ residents: [...conn!.db.residents.iter()].sort((a, b) => Number(a.id - b.id)) });
}
function refreshTrips() {
  rebuild({ trips: [...conn!.db.trips.iter()].sort((a, b) => Number(a.id - b.id)) });
}
function refreshEvents() {
  rebuild({ events: [...conn!.db.tripEvents.iter()].sort((a, b) => Number(a.id - b.id)) });
}
function refreshTelemetry() {
  rebuild({ telemetry: [...conn!.db.telemetry.iter()].sort((a, b) => Number(a.id - b.id)) });
}
function refreshRecs() {
  rebuild({ recs: [...conn!.db.aiRecommendations.iter()].sort((a, b) => Number(a.id - b.id)) });
}
function refreshCommunity() {
  const all = [...conn!.db.community.iter()];
  rebuild({ community: all[0] ?? null });
}

function registerCallbacks(c: DbConnection) {
  c.db.vehicles.onInsert((_ctx: EventContext, r: Vehicle) => {
    flash(`vehicle-${r.id}`);
    refreshVehicles();
  });
  c.db.vehicles.onUpdate((_ctx: EventContext, _o: Vehicle, r: Vehicle) => {
    flash(`vehicle-${r.id}`);
    refreshVehicles();
  });
  c.db.vehicles.onDelete(() => refreshVehicles());

  c.db.residents.onInsert(() => refreshResidents());
  c.db.residents.onUpdate(() => refreshResidents());
  c.db.residents.onDelete(() => refreshResidents());

  c.db.trips.onInsert((_ctx: EventContext, r: Trip) => {
    flash(`trip-${r.id}`);
    refreshTrips();
  });
  c.db.trips.onUpdate((_ctx: EventContext, _o: Trip, r: Trip) => {
    flash(`trip-${r.id}`);
    flash(`trip-state-${r.id}`);
    refreshTrips();
  });
  c.db.trips.onDelete(() => refreshTrips());

  c.db.tripEvents.onInsert((_ctx: EventContext, r: TripEvent) => {
    flash(`event-${r.id}`);
    refreshEvents();
  });
  c.db.tripEvents.onDelete(() => refreshEvents());

  c.db.telemetry.onInsert((_ctx: EventContext, r: Telemetry) => {
    flash(`telemetry-${r.id}`);
    flash(`telemetry-latest`);
    refreshTelemetry();
  });
  c.db.telemetry.onDelete(() => refreshTelemetry());

  c.db.aiRecommendations.onInsert((_ctx: EventContext, r: AiRecommendation) => {
    flash(`rec-${r.id}`);
    refreshRecs();
  });
  c.db.aiRecommendations.onDelete(() => refreshRecs());

  c.db.community.onInsert(() => refreshCommunity());
  c.db.community.onUpdate(() => refreshCommunity());
  c.db.community.onDelete(() => refreshCommunity());
}

export function start() {
  if (started) return;
  started = true;

  const token = localStorage.getItem("voltpass_token") ?? undefined;

  DbConnection.builder()
    .withUri(wsUri())
    .withModuleName(MODULE_NAME)
    .withToken(token)
    .onConnect((c: DbConnection, identity: Identity, tok: string) => {
      conn = c;
      localStorage.setItem("voltpass_token", tok);
      rebuild({ connected: true, identity: identity.toHexString() });
      registerCallbacks(c);

      c.subscriptionBuilder()
        .onApplied(() => {
          refreshVehicles();
          refreshResidents();
          refreshTrips();
          refreshEvents();
          refreshTelemetry();
          refreshRecs();
          refreshCommunity();
        })
        .subscribe([
          "SELECT * FROM vehicles",
          "SELECT * FROM residents",
          "SELECT * FROM trips",
          "SELECT * FROM trip_events",
          "SELECT * FROM telemetry",
          "SELECT * FROM ai_recommendations",
          "SELECT * FROM community",
        ]);
    })
    .onDisconnect(() => {
      rebuild({ connected: false });
    })
    .onConnectError((_ctx, err: Error) => {
      console.error("VoltPass connection error:", err);
      rebuild({ connected: false });
    })
    .build();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): Snapshot {
  return snapshot;
}

export function getConnection(): DbConnection | null {
  return conn;
}

// ---- Reducer actions ------------------------------------------------------

export function reserveVehicle(vehicleId: bigint, renter: string) {
  conn?.reducers.reserveVehicle({ vehicleId, renter });
}
export function approveUnlock(tripId: bigint) {
  conn?.reducers.approveUnlock({ tripId });
}
export function startReturn(tripId: bigint) {
  conn?.reducers.startReturn({ tripId });
}
export function pushTelemetry(
  tripId: bigint,
  battery: number,
  odometerDelta: number,
  harshBrake: boolean,
  geofenceOk: boolean,
) {
  conn?.reducers.pushTelemetry({ tripId, battery, odometerDelta, harshBrake, geofenceOk });
}
export function seedDemoData() {
  conn?.reducers.seedDemoData({});
}

// AI Trust Agent reducers (persist-only). Called by the standalone agent and,
// as a fallback, by the owner-side agent in the browser.
export function aiWriteRecommendation(
  tripId: bigint,
  kind: string,
  verdict: string,
  body: string,
) {
  conn?.reducers.aiWriteRecommendation({ tripId, kind, verdict, body });
}
export function generateCloseout(tripId: bigint, verdict: string, body: string) {
  conn?.reducers.generateCloseout({ tripId, verdict, body });
}
