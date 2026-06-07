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

**Reducers** (server-side functions; they only validate state transitions and
persist data — they never make outbound HTTP/LLM calls):

- `seed_demo_data` — resets + seeds the community, fleet and residents
- `reserve_vehicle` *(resident)* — opens the Trip Room and runs the deterministic
  check-in cascade (RESERVED → CHECK_IN_STARTED → VEHICLE_VERIFIED) including the
  vehicle telemetry snapshot. Stops at VEHICLE_VERIFIED — it writes **no** AI
  content.
- `ai_write_recommendation(trip_id, kind, verdict, body)` *(AI Trust Agent)* —
  **persist-only.** Stores the structured row the agent computed and appends a
  timeline event. Idempotent per (trip, kind).
- `approve_unlock` *(owner)* — grants access and activates the trip (→ TRIP_ACTIVE)
- `push_telemetry` *(telemetry simulator)* — writes a telemetry row, updates the
  live battery and appends a timeline event
- `start_return` *(resident)* — moves the trip to AI_REVIEWING and stops, signalling
  the AI Trust Agent
- `generate_closeout(trip_id, verdict, body)` *(AI Trust Agent)* — **persist-only.**
  Stores the closeout the agent computed, then performs the deterministic
  AI_REVIEWING → CLOSED transition and frees the vehicle. Idempotent.

Each reducer is annotated with the **actor** that calls it. The resident, the
owner, the telemetry simulator, and the AI Trust Agent are four distinct actors,
all writing to the one authoritative shared state.

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

**The agent is not a chatbot, and it does not run inside the database.**
SpacetimeDB reducers are sandboxed and must not make outbound HTTP/LLM calls, so
the AI Trust Agent is a **separate actor** (the standalone process in
[`agent/`](agent/src/index.ts)). It:

1. **Subscribes** to the shared state (`trips`, `telemetry`, `trip_events`,
   `vehicles`, `residents`, `ai_recommendations`).
2. **Decides** when an artifact is needed:
   - a trip reaches `VEHICLE_VERIFIED` → write an **unlock recommendation**
     (verdict `APPROVE` / `REVIEW`) from the renter's verification + VoltScore and
     the vehicle snapshot;
   - a trip reaches `AI_REVIEWING` → write a **closeout report**
     (verdict `CLEAN_CLOSE` / `REVIEW`) computed from the actual telemetry rows
     (battery delta, odometer total, harsh-braking count, geofence status).
3. **Optionally calls an LLM** for the closeout prose — only when
   `ANTHROPIC_API_KEY` is set, and only as an enhancement; the structured verdict
   always comes from telemetry.
4. **Always has a hardcoded fallback**, so the demo never depends on an external
   API.
5. **Writes back through reducers** — `ai_write_recommendation` and
   `generate_closeout` — which only persist what they are handed.

The shared decision logic lives in
[`client/src/ai/agent-logic.ts`](client/src/ai/agent-logic.ts).

> **Demo resilience:** the owner window also runs the same logic as a *fallback*
> (`client/src/ai/useOwnerAgentFallback.ts`). If the standalone agent process
> isn't running, the owner page writes the artifacts after a short grace period.
> The reducers are idempotent per (trip, kind), so the standalone agent and the
> fallback can never produce a duplicate.

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

# 4. in a fourth terminal: run the AI Trust Agent (a separate actor)
cd agent
npm install
npm start          # optional: ANTHROPIC_API_KEY=sk-... npm start  (LLM closeout)
```

Then open the two windows side by side:

- http://localhost:5173/resident
- http://localhost:5173/owner

> The AI Trust Agent in step 4 is the honest architecture. If you skip it, the
> owner window's built-in fallback still writes the AI artifacts, so the demo
> loop always completes.

> The client connects to `ws://<host>:3000` by default. Override with
> `?stdb=ws://host:port` on either page if your DB is elsewhere.

## 90-second demo script

1. **Open `/resident` and `/owner` side by side.** Point out the green
   *SpacetimeDB connected* pill and the live `trips` debug strip on both.
2. **(`/resident`) Click _Reserve_** on the Tesla Model 3.
   → On **`/owner`**, the reservation card and the **telemetry snapshot** flash in
   *instantly* (no refresh); the state pill reads *Vehicle verified* in both
   windows. A beat later the **AI Trust Agent** — a separate actor — posts its
   **unlock recommendation** into SpacetimeDB and it flashes into both windows.
3. **(`/owner`) Click _Approve Unlock_.** → Both windows flip to *Trip active*;
   the Model 3 flips to *Active Trip* in the fleet.
4. **(`/owner`) Click _Simulate Trip_.** → Telemetry streams live: battery ticks
   `82 → 61`, odometer climbs to `+14.2 mi`, a harsh-brake event flags. Every row
   appears in both windows as it lands.
5. **(`/resident`) Click _Start Return_.** → The trip moves to *AI reviewing*.
   The **AI Trust Agent** reads the telemetry, writes the **closeout report**
   into SpacetimeDB, and that write closes the trip. Both windows show the report
   and flip to *Closed*; the Model 3 returns to *Available*.
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
