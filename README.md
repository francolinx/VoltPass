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
| `vehicles` | id, model, battery, location, status + live fields: source, latitude, longitude, location_confirmed, lock_status, charge_status, smartcar_vehicle_id |
| `residents` | id, name, voltscore, status |
| `trips` | id, vehicle_id, renter, state, created_at — *the Trip Room* |
| `trip_events` | id, trip_id, kind, payload, timestamp — *the live timeline* |
| `telemetry` | id, trip_id, battery, odometer_delta, harsh_brake, geofence_ok, timestamp, source, latitude, longitude, location_confirmed, lock_status |
| `vehicle_snapshots` | id, vehicle_id, trip_id, source, battery_pct, odometer, latitude, longitude, location_confirmed, lock_status, charge_status, smartcar_vehicle_id, captured_at — *rich Smartcar/sim snapshots* |
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
- `connect_smartcar_vehicle(smartcar_vehicle_id, model, label)` *(Smartcar connector)* —
  **persist-only.** Upserts a real Smartcar-connected vehicle into the fleet.
- `ingest_smartcar_snapshot(vehicle_id, trip_id, source, battery_pct, odometer, latitude, longitude, location_confirmed, lock_status, charge_status, smartcar_vehicle_id)`
  *(Smartcar connector)* — **persist-only.** Updates the vehicle's live state, writes a
  `vehicle_snapshots` audit row, and (during an active trip) a telemetry row.
- `record_unlock_command(trip_id, vehicle_id, command_status)` *(Smartcar connector)* —
  **persist-only.** Records that an unlock command was sent.
- `confirm_unlock_status(trip_id, vehicle_id, lock_status)` *(Smartcar connector)* —
  **persist-only.** Records the lock status read back after the command.

Each reducer is annotated with the **actor** that calls it. The resident, the
owner, the telemetry simulator, the **Smartcar connector**, and the AI Trust
Agent are five distinct actors, all writing to the one authoritative shared
state. **No reducer ever calls Smartcar, an LLM, or any network service.**

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

## Real vehicle integration (Smartcar)

VoltPass connects **real Teslas through Smartcar** for live state-of-charge, GPS,
parked-location confirmation, lock/security status, and remote unlock — while
keeping SpacetimeDB as the authoritative trip ledger and never compromising the
demo.

**Architecture (secrets stay server-side):**

```
Smartcar Connect OAuth
  → server-side connector (api/, holds the Client Secret + tokens)
  → Smartcar API (battery / location / odometer / security / unlock)
  → SpacetimeDB persist-only reducers
  → live Trip Room updates in /resident and /owner
```

- The **Client Secret and access/refresh tokens live only in `api/`** (server-side
  env). The browser never sees them — it only calls the connector's routes.
- **No reducer calls Smartcar.** The connector calls Smartcar, then persists the
  results via the persist-only reducers above.
- If Smartcar isn't configured, or OAuth / a command fails, the connector
  **falls back to a local simulator** and the two-window SpacetimeDB demo keeps
  working. Real Smartcar is the preferred path when credentials are present.

**Scopes requested:** `read_vehicle_info`, `read_battery`, `read_charge`,
`read_location`, `read_odometer`, `read_security`, `control_security`.

**Tesla note:** during Smartcar/Tesla authorization the owner must grant the
matching Tesla permissions — *Vehicle Information* (battery/odometer/security
reads), *Vehicle Location* (GPS), and *Vehicle Commands* (lock/unlock via
`control_security`).

**Environment variables** (`api/.env`, see [`api/.env.example`](api/.env.example)):

```
SMARTCAR_CLIENT_ID=
SMARTCAR_CLIENT_SECRET=
SMARTCAR_REDIRECT_URI=http://localhost:5173/callback
SMARTCAR_TEST_MODE=false
```

**Connector routes** (`api/src/index.ts`):

| Route | Purpose |
|---|---|
| `GET /api/smartcar/auth-url` | Build the Smartcar Connect URL (with scopes) |
| `GET /api/smartcar/callback?code=…` | Exchange code → tokens, list vehicles, register them in SpacetimeDB |
| `GET /api/smartcar/vehicles` | List connected vehicles (make/model/year/id) |
| `POST /api/smartcar/snapshot` | Fetch live battery/GPS/odometer/lock, confirm geofence, `ingest_smartcar_snapshot` |
| `POST /api/smartcar/unlock` | Send Smartcar unlock, `record_unlock_command` → advance trip → `confirm_unlock_status` |
| `POST /api/smartcar/connect-simulator` | Connect simulated Teslas (fallback, no OAuth) |

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

## What is real vs simulated

- **Real:** when Smartcar credentials are configured, live battery/SOC, GPS,
  odometer, parked-location confirmation, lock status, and the **remote unlock
  command** come from real Teslas via Smartcar (see the section above).
- **Simulated (fallback):** the in-trip telemetry stream (the owner's
  *Simulate Trip* button — battery `82 → 61`, odometer `+14.2 mi`, one
  `harsh_brake`, `geofence_ok`) is a **simulator-backed vehicle connector that
  mirrors Smartcar/Tesla telemetry events** for reliable demo execution. The
  Smartcar connector also falls back to simulated vehicles if no credentials are
  present or a call fails — so the SpacetimeDB demo never breaks.

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

# 5. in a fifth terminal: run the Smartcar connector (a separate actor)
cd api
npm install
cp .env.example .env   # fill in SMARTCAR_CLIENT_ID / SMARTCAR_CLIENT_SECRET
npm start              # with no creds it runs in simulator mode
```

Then open the two windows side by side:

- http://localhost:5173/resident
- http://localhost:5173/owner

> Steps 4 and 5 are the honest architecture (AI Trust Agent + Smartcar connector
> as separate actors). If you skip the agent, the owner window's built-in
> fallback still writes the AI artifacts. If you skip Smartcar creds, the
> connector runs in simulator mode. Either way the two-window SpacetimeDB loop
> always completes.

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

## Demo script — real Tesla unlock via Smartcar

With the connector running (and Smartcar creds for real cars):

1. **(`/owner`)** In **Smartcar Live Mode**, click **Connect Smartcar** →
   authorize Tesla through Smartcar → you return to `/owner` with your real
   Teslas (Model X, Model S, Model S) listed.
2. **Select a Tesla** and click **Pull Live Snapshot** → the panel shows real
   **SOC %**, **GPS**, **Parked where expected: confirmed**, and **lock status**
   — all written into SpacetimeDB, so `/resident` updates live too.
3. **(`/resident`)** The connected Tesla now shows with its **live SOC** and a
   **"Vehicle location confirmed"** badge. Click **Reserve**.
4. The **AI Trust Agent** writes its unlock recommendation **using the live
   Smartcar snapshot** ("…snapshot captured at 78% battery in Community Garage…").
5. **(`/owner`)** Click **Unlock via Smartcar** → a real unlock command is sent
   to the Tesla; SpacetimeDB records *unlock requested → command sent →
   unlocked*, the trip goes *Trip active*, and both windows update live.
6. Continue with **Simulate Trip** / **Start Return** as above, or finish the
   trip. If Smartcar is unavailable at any point, **Use simulator fallback** and
   the loop still completes.

## Future roadmap

- Reverse-geocoded parked locations and richer geofence policies
- LLM-authored closeout prose (same structured `ai_recommendations` schema)
- VoltScore as a learned model over historical trip + Smartcar telemetry
- Dispute & damage flows as additional Trip Room states
- The **underwriting dataset**: priced risk for community EV sharing

---

*Built for the SpacetimeDB Launchpad Hackathon. SpacetimeDB is the core
real-time backend — the live trip ledger that makes the trust loop possible.*
