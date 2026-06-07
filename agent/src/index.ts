// VoltPass AI Trust Agent — standalone process.
//
// This is a separate actor (NOT a SpacetimeDB reducer). It subscribes to the
// shared Trip Room state, decides when an AI artifact is needed, optionally
// calls an LLM for the closeout, and writes its structured result back through
// the persist-only reducers `ai_write_recommendation` and `generate_closeout`.
//
// Run:  npm install && npm start
// Env:  STDB_URI (default ws://127.0.0.1:3000), VOLTPASS_MODULE (default voltpass),
//       ANTHROPIC_API_KEY (optional — enables LLM-authored closeout prose),
//       VOLTPASS_LLM_MODEL (optional model id).

import { DbConnection, type EventContext } from "../../client/src/module_bindings/index.ts";
import type { Trip } from "../../client/src/types.ts";
import {
  computeUnlockRecommendation,
  computeCloseout,
} from "../../client/src/ai/agent-logic.ts";

const URI = process.env.STDB_URI ?? "ws://127.0.0.1:3000";
const MODULE = process.env.VOLTPASS_MODULE ?? "voltpass";
const API_KEY = process.env.ANTHROPIC_API_KEY;
const LLM_MODEL = process.env.VOLTPASS_LLM_MODEL;

const attempted = new Set<string>(); // `${tripId}-${kind}` we've already handled

function log(...a: unknown[]) {
  console.log(new Date().toISOString(), "[ai-agent]", ...a);
}

let conn: DbConnection;

function hasRec(tripId: bigint, kind: string): boolean {
  for (const r of conn.db.aiRecommendations.iter()) {
    if (r.tripId === tripId && r.kind === kind) return true;
  }
  return false;
}

async function react(trip: Trip) {
  // 1. Unlock recommendation once a trip is verified.
  if (trip.state === "VEHICLE_VERIFIED") {
    const key = `${trip.id}-unlock`;
    if (!attempted.has(key) && !hasRec(trip.id, "unlock")) {
      attempted.add(key);
      const vehicle = [...conn.db.vehicles.iter()].find((v) => v.id === trip.vehicleId);
      const resident = [...conn.db.residents.iter()].find((r) => r.name === trip.renter);
      const art = computeUnlockRecommendation({
        renter: trip.renter,
        voltscore: resident?.voltscore ?? 0,
        verified: resident?.status === "verified",
        battery: vehicle?.battery ?? 0,
        location: vehicle?.location ?? "the garage",
        model: vehicle?.model ?? "vehicle",
      });
      log(`writing unlock recommendation for trip #${trip.id}: ${art.verdict}`);
      conn.reducers.aiWriteRecommendation({
        tripId: trip.id,
        kind: "unlock",
        verdict: art.verdict,
        body: art.body,
      });
    }
  }

  // 2. Closeout report once the resident has started the return.
  if (trip.state === "AI_REVIEWING") {
    const key = `${trip.id}-closeout`;
    if (!attempted.has(key) && !hasRec(trip.id, "closeout")) {
      attempted.add(key);
      const rows = [...conn.db.telemetry.iter()]
        .filter((r) => r.tripId === trip.id)
        .sort((a, b) => Number(a.id - b.id))
        .map((r) => ({
          battery: r.battery,
          odometerDelta: r.odometerDelta,
          harshBrake: r.harshBrake,
          geofenceOk: r.geofenceOk,
        }));
      log(`generating closeout for trip #${trip.id} (${rows.length} telemetry rows)`);
      const art = await computeCloseout(rows, { apiKey: API_KEY, model: LLM_MODEL });
      if (hasRec(trip.id, "closeout")) return; // someone beat us to it
      log(`writing closeout for trip #${trip.id}: ${art.verdict}`);
      conn.reducers.generateCloseout({
        tripId: trip.id,
        verdict: art.verdict,
        body: art.body,
      });
    }
  }
}

DbConnection.builder()
  .withUri(URI)
  .withModuleName(MODULE)
  .onConnect((c, identity) => {
    conn = c;
    log(`connected to ${URI}/${MODULE} as ${identity.toHexString().slice(0, 12)}`);
    log(API_KEY ? "LLM closeout ENABLED" : "LLM closeout disabled (using deterministic fallback)");

    c.db.trips.onInsert((_ctx: EventContext, t: Trip) => void react(t));
    c.db.trips.onUpdate((_ctx: EventContext, _o: Trip, t: Trip) => void react(t));

    c.subscriptionBuilder()
      .onApplied(() => {
        log("subscribed. scanning existing trips…");
        for (const t of c.db.trips.iter()) void react(t);
      })
      .subscribe([
        "SELECT * FROM trips",
        "SELECT * FROM telemetry",
        "SELECT * FROM trip_events",
        "SELECT * FROM vehicles",
        "SELECT * FROM residents",
        "SELECT * FROM ai_recommendations",
      ]);
  })
  .onConnectError((_ctx, err: Error) => {
    log("connect error:", err.message);
    process.exit(1);
  })
  .onDisconnect(() => log("disconnected"))
  .build();

log(`AI Trust Agent starting; connecting to ${URI} …`);
