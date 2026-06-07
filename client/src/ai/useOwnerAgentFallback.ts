// Owner-side AI Trust Agent fallback.
//
// The canonical AI Trust Agent is the standalone process in `agent/`. But so the
// live demo never stalls if a judge didn't start that process, the owner window
// runs the same decision logic as a fallback: after a short grace period (long
// enough for the real agent to win), if the expected AI artifact is still
// missing from SpacetimeDB, it computes and writes it via the persist-only
// reducers. The reducers are idempotent per (trip, kind), so the standalone
// agent and this fallback can never produce a duplicate.

import { useEffect, useRef } from "react";
import { getSnapshot, aiWriteRecommendation, generateCloseout } from "../store";
import type { Snapshot } from "../store";
import { activeTrip } from "../hooks";
import {
  computeUnlockRecommendation,
  computeCloseoutFallback,
} from "./agent-logic";

const GRACE_MS = 1200;

export function useOwnerAgentFallback(snap: Snapshot) {
  const attempted = useRef<Set<string>>(new Set());

  const trip = activeTrip(snap);
  const tripId = trip?.id;
  const tripState = trip?.state;
  const hasUnlock = !!trip && snap.recs.some((r) => r.tripId === trip.id && r.kind === "unlock");
  const hasCloseout = !!trip && snap.recs.some((r) => r.tripId === trip.id && r.kind === "closeout");

  useEffect(() => {
    if (!trip || !snap.connected) return;

    const needsUnlock = tripState === "VEHICLE_VERIFIED" && !hasUnlock;
    const needsCloseout = tripState === "AI_REVIEWING" && !hasCloseout;
    if (!needsUnlock && !needsCloseout) return;

    const kind = needsUnlock ? "unlock" : "closeout";
    const key = `${trip.id}-${kind}`;
    if (attempted.current.has(key)) return;

    const timer = setTimeout(() => {
      // Re-read the live state: the standalone agent may have written it already.
      const live = getSnapshot();
      const t = activeTrip(live);
      if (!t || t.id !== trip.id) return;
      const exists = live.recs.some((r) => r.tripId === t.id && r.kind === kind);
      if (exists) return;
      attempted.current.add(key);

      if (kind === "unlock") {
        const vehicle = live.vehicles.find((v) => v.id === t.vehicleId);
        const resident = live.residents.find((r) => r.name === t.renter);
        const art = computeUnlockRecommendation({
          renter: t.renter,
          voltscore: resident?.voltscore ?? 0,
          verified: resident?.status === "verified",
          battery: vehicle?.battery ?? 0,
          location: vehicle?.location ?? "the garage",
          model: vehicle?.model ?? "vehicle",
        });
        aiWriteRecommendation(t.id, "unlock", art.verdict, art.body);
      } else {
        const rows = live.telemetry
          .filter((r) => r.tripId === t.id)
          .map((r) => ({
            battery: r.battery,
            odometerDelta: r.odometerDelta,
            harshBrake: r.harshBrake,
            geofenceOk: r.geofenceOk,
          }));
        const art = computeCloseoutFallback(rows);
        generateCloseout(t.id, art.verdict, art.body);
      }
    }, GRACE_MS);

    return () => clearTimeout(timer);
  }, [tripId, tripState, hasUnlock, hasCloseout, snap.connected, trip]);
}
