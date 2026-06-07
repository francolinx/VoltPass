import { useSyncExternalStore, useEffect, useState } from "react";
import {
  subscribe,
  getSnapshot,
  start,
  type Snapshot,
} from "./store";
import type { Trip } from "./types";

export function useVoltPass(): Snapshot {
  useEffect(() => {
    start();
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The trip the demo is currently focused on: the most-recently-created one. */
export function activeTrip(snap: Snapshot): Trip | null {
  if (snap.trips.length === 0) return null;
  return snap.trips[snap.trips.length - 1];
}

/** Returns true for ~1.1s after the given flash key last changed, so callers
 * can apply a pulse highlight. Re-renders itself as the window expires. */
export function useFlash(snap: Snapshot, key: string): boolean {
  const ts = snap.flashes[key];
  const [, force] = useState(0);
  const active = ts !== undefined && Date.now() - ts < 1100;
  useEffect(() => {
    if (active) {
      const t = setTimeout(() => force((n) => n + 1), 1150);
      return () => clearTimeout(t);
    }
  }, [ts, active]);
  return active;
}

export function fmtTime(ts: { toDate: () => Date } | null | undefined): string {
  if (!ts) return "";
  try {
    return ts.toDate().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}
