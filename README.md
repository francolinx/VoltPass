# ⚡ VoltPass

### Real-time Trust OS for resident-only EV sharing

> **VoltPass is not a Turo clone. It is the real-time trust OS for resident-only EV sharing inside high-trust apartment communities.**

The core product object is the **Trip Room**: a shared state machine between
renter, owner, vehicle telemetry, and an AI Trust Agent — all living inside
SpacetimeDB as one authoritative, live-synced ledger.

---

## What VoltPass does

In a community like *Microsoft Apartments*, a handful of residents own EVs and
the rest want occasional access. VoltPass turns each rental into a **Trip Room**:
a single shared state machine that the renter, the owner, the vehicle's
telemetry, and an AI Trust Agent all read from and write to at the same time.

Open two windows side by side:

- **`/resident`** — reserve a car, watch check-in happen, start the return.
- **`/owner`** — see the reservation appear instantly, approve the unlock,
  simulate the trip, watch telemetry stream, read the AI closeout.

An action in one window updates the other **instantly**, with no refresh,
because both windows are subscribed to the same SpacetimeDB tables.

## Why it is not a Turo clone

Turo is a marketplace: listings, search, payments, strangers. VoltPass is a
**trust layer** for a closed, high-trust community. The product is not the
listing — it's the **live trust state of an in-progress trip**: who is verified,
what the vehicle is doing right now, whether the AI recommends unlock, and
whether the car came back clean. The long-term business is not just rentals —
**it is the underwriting dataset for safe community EV sharing.**

## The Trip Room state machine

Every meaningful change is a server-enforced transition inside SpacetimeDB:

```
AVAILABLE
  → RESERVED
  → CHECK_IN_STARTED
  → VEHICLE_VERIFIED      (telemetry snapshot ingested + AI unlock recommendation written)
  → UNLOCK_GRANTED
  → TRIP_ACTIVE
  → RETURN_STARTED
  → AI_REVIEWING          (AI closeout report written from telemetry)
  → CLOSED
```

Illegal transitions are rejected by the reducers, so the shared state can never
get into an inconsistent place — no matter which window clicked what.

## Why SpacetimeDB is essential

**SpacetimeDB is the live trip ledger.** Every unlock, telemetry snapshot, risk
update, and return event moves through one authoritative shared state. It is not
used as a passive store behind an API — it *is* the product loop:

- The state machine lives in **reducers**, which enforce legal transitions
  server-side.
- The AI Trust Agent is a **participant in shared state** — it writes rows.
- The two browser windows are **subscribers**; the live sync between them is the
  whole demo, and it comes for free from SpacetimeDB subscriptions.

Remove SpacetimeDB and there is no product — you'd be rebuilding subscriptions,
a state machine, and a real-time fan-out from scratch.

## Exact tables / reducers / subscriptions

**Tables** (all `public`, defined in [`server/src/lib.rs`](server/src/lib.rs)):

| Table | Meaning |
|---|---|
| `vehicles` | id, model, battery, location, status |
| `residents` | id, name, voltscore, status |
| `trips` | id, vehicle_id, renter, state, created_at — *the Trip Room* |
| `trip_events` | id, trip_id, kind, payload, timestamp — *the live timeline* |
| `telemetry` | id, trip_id, battery, odometer_delta, harsh_brake, geofence_ok, timestamp |
| `ai_recommendations` | id, trip_id, kind, verdict, body, created_at — *AI Trust Agent output* |
| `community` | id, name, teslas, residents, chargers — *Community Ops stats* |

**Reducers** (server-side functions; enforce the state machine):

- `seed_demo_data` — resets + seeds the community, fleet and residents
- `reserve_vehicle` — opens the Trip Room and runs the check-in cascade
  (RESERVED → CHECK_IN_STARTED → VEHICLE_VERIFIED) including the vehicle snapshot
  and the AI unlock recommendation
- `start_checkin`, `ingest_vehicle_snapshot`, `ai_write_recommendation` —
  the individual check-in steps (also callable standalone)
- `approve_unlock` — owner grants access; activates the trip (→ TRIP_ACTIVE)
- `start_trip` — standalone activation
- `push_telemetry` — simulator-backed vehicle connector writes a telemetry row,
  updates the live battery and appends a timeline event
- `start_return` — runs the closeout cascade
  (RETURN_STARTED → AI_REVIEWING → CLOSED), generating the AI closeout from
  telemetry
- `generate_closeout`, `close_trip` — the individual closeout steps

**Subscriptions** (both clients subscribe to all of these):

```sql
SELECT * FROM vehicles
SELECT * FROM residents
SELECT * FROM trips
SELECT * FROM trip_events
SELECT * FROM telemetry
SELECT * FROM ai_recommendations
SELECT * FROM community
```

## How the AI Trust Agent works

**The agent is not a chatbot. It is a participant in shared state.** It reads the
trip and its telemetry, then writes structured rows into `ai_recommendations`
that humans and the UI act on:

1. **Unlock recommendation** — written during check-in. It checks the renter's
   verification status and VoltScore and the vehicle snapshot, then emits a
   verdict (`APPROVE` / `REVIEW`) and a human-readable body.
2. **Closeout report** — written when the resident starts the return. It is
   **computed from the actual telemetry rows** for the trip (battery delta,
   odometer total, harsh-braking count, geofence status) and emits a verdict
   (`CLEAN_CLOSE` / `REVIEW`).

The closeout always has a **hardcoded fallback**, so the demo never depends on an
external API. (A real LLM call can be slotted into `generate_closeout` to author
the prose from the same telemetry — the structured row contract stays identical.)

## What is simulated

- **Vehicle telemetry** is produced by a **simulator-backed vehicle connector
  that mirrors Smartcar/Tesla telemetry events** for reliable demo execution. No
  real Smartcar/Tesla API is called. The owner's *Simulate Trip* button streams
  telemetry rows through SpacetimeDB one at a time:
  battery `82 → 61`, odometer `+14.2 mi`, one `harsh_brake`, `geofence_ok`.

## How to run locally

**Prerequisites:** [Rust](https://rustup.rs) (+ `wasm32-unknown-unknown` target),
[Node 18+](https://nodejs.org), the [SpacetimeDB CLI](https://spacetimedb.com/install),
and `openssl`.

```bash
# 0. one-time: wasm target for building the module
rustup target add wasm32-unknown-unknown

# 1. start SpacetimeDB (keeps running)
./scripts/start-db.sh

# 2. in a second terminal: build + publish the module and regenerate bindings
./scripts/publish.sh

# 3. in a third terminal: run the web client
cd client
npm install
npm run dev
```

Then open the two windows side by side:

- http://localhost:5173/resident
- http://localhost:5173/owner

> The client connects to `ws://<host>:3000` by default. Override with
> `?stdb=ws://host:port` on either page if your DB is elsewhere.

## 90-second demo script

1. **Open `/resident` and `/owner` side by side.** Point out the green
   *SpacetimeDB connected* pill and the live `trips` debug strip on both.
2. **(`/resident`) Click _Reserve_** on the Tesla Model 3.
   → On **`/owner`**, the reservation card, the **telemetry snapshot**, and the
   **AI unlock recommendation** all flash in *instantly* — no refresh. The state
   pill reads *Vehicle verified* in both windows.
3. **(`/owner`) Click _Approve Unlock_.** → Both windows flip to *Trip active*;
   the Model 3 flips to *Active Trip* in the fleet.
4. **(`/owner`) Click _Simulate Trip_.** → Telemetry streams live: battery ticks
   `82 → 61`, odometer climbs to `+14.2 mi`, a harsh-brake event flags. Every row
   appears in both windows as it lands.
5. **(`/resident`) Click _Start Return_.** → The AI Trust Agent writes the
   **closeout report** (computed from the telemetry) into SpacetimeDB; both
   windows show it and the trip closes. The Model 3 returns to *Available*.
6. *Reset with the ↺ button to run it again.*

The whole point: **a judge sees shared live state across two windows within 10
seconds**, and every change went through SpacetimeDB.

## Future roadmap

- Real Smartcar/Tesla connector behind the same telemetry row contract
- LLM-authored closeout prose (same structured `ai_recommendations` schema)
- VoltScore as a learned model over historical trip telemetry
- Dispute & damage flows as additional Trip Room states
- The **underwriting dataset**: priced risk for community EV sharing

---

*Built for the SpacetimeDB Launchpad Hackathon. SpacetimeDB is the core
real-time backend — the live trip ledger that makes the trust loop possible.*
