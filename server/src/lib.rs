//! VoltPass — Real-time Trust OS for resident-only EV sharing.
//!
//! SpacetimeDB is the live "Trip Room" ledger. Every meaningful state change in
//! the trip lifecycle — reservation, vehicle snapshot, AI recommendation, unlock,
//! telemetry, return and closeout — moves through one authoritative shared state
//! here, and is streamed to every subscribed client in real time.
//!
//! ARCHITECTURE NOTE — reducers are sandboxed and never make outbound HTTP/LLM
//! calls. They only validate state transitions and persist data passed into
//! them. The AI Trust Agent is a *separate actor* (see `agent/`): it subscribes
//! to this shared state, decides when an artifact is needed, optionally calls an
//! LLM, and then writes its structured result back through the persist-only
//! reducers `ai_write_recommendation` and `generate_closeout`.
//!
//! The actors writing to this shared state are therefore: the resident, the
//! owner, the telemetry simulator (the owner's "Simulate Trip" connector), and
//! the AI Trust Agent — all distinct, all authoritative through reducers.

use spacetimedb::{ReducerContext, Table, Timestamp};

// ---------------------------------------------------------------------------
// Trip Room state machine
// ---------------------------------------------------------------------------
//
// AVAILABLE
//   -> RESERVED
//   -> CHECK_IN_STARTED
//   -> VEHICLE_VERIFIED      (snapshot ingested; AI agent then writes unlock rec)
//   -> UNLOCK_GRANTED
//   -> TRIP_ACTIVE
//   -> RETURN_STARTED
//   -> AI_REVIEWING          (AI agent then writes closeout, which closes trip)
//   -> CLOSED

mod state {
    pub const RESERVED: &str = "RESERVED";
    pub const CHECK_IN_STARTED: &str = "CHECK_IN_STARTED";
    pub const VEHICLE_VERIFIED: &str = "VEHICLE_VERIFIED";
    pub const UNLOCK_GRANTED: &str = "UNLOCK_GRANTED";
    pub const TRIP_ACTIVE: &str = "TRIP_ACTIVE";
    pub const RETURN_STARTED: &str = "RETURN_STARTED";
    pub const AI_REVIEWING: &str = "AI_REVIEWING";
    pub const CLOSED: &str = "CLOSED";
}

// ---------------------------------------------------------------------------
// Tables  (all `public` so the browser clients and the agent can subscribe)
// ---------------------------------------------------------------------------

#[spacetimedb::table(name = vehicles, public)]
#[derive(Clone)]
pub struct Vehicle {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub model: String,
    pub battery: i32,
    pub location: String,
    pub status: String, // Available | Reserved | Active Trip | Charging
}

#[spacetimedb::table(name = residents, public)]
#[derive(Clone)]
pub struct Resident {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub name: String,
    pub voltscore: i32,
    pub status: String, // verified | pending
}

#[spacetimedb::table(name = trips, public)]
#[derive(Clone)]
pub struct Trip {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub vehicle_id: u64,
    pub renter: String,
    pub state: String,
    pub created_at: Timestamp,
}

#[spacetimedb::table(name = trip_events, public)]
#[derive(Clone)]
pub struct TripEvent {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub trip_id: u64,
    pub kind: String,
    pub payload: String,
    pub timestamp: Timestamp,
}

#[spacetimedb::table(name = telemetry, public)]
#[derive(Clone)]
pub struct Telemetry {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub trip_id: u64,
    pub battery: i32,
    pub odometer_delta: f32,
    pub harsh_brake: bool,
    pub geofence_ok: bool,
    pub timestamp: Timestamp,
}

#[spacetimedb::table(name = ai_recommendations, public)]
#[derive(Clone)]
pub struct AiRecommendation {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub trip_id: u64,
    pub kind: String,    // unlock | closeout
    pub verdict: String, // APPROVE | REVIEW | CLEAN_CLOSE
    pub body: String,
    pub created_at: Timestamp,
}

/// Static community context for the "Community Ops" panel. One row.
#[spacetimedb::table(name = community, public)]
#[derive(Clone)]
pub struct Community {
    #[primary_key]
    pub id: u64,
    pub name: String,
    pub teslas: i32,
    pub residents: i32,
    pub chargers: i32,
}

// ---------------------------------------------------------------------------
// Lifecycle reducers
// ---------------------------------------------------------------------------

#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) {
    // Seed automatically on first publish so the demo is never empty.
    seed_demo_data(ctx);
}

#[spacetimedb::reducer(client_connected)]
pub fn identity_connected(_ctx: &ReducerContext) {}

#[spacetimedb::reducer(client_disconnected)]
pub fn identity_disconnected(_ctx: &ReducerContext) {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn log_event(ctx: &ReducerContext, trip_id: u64, kind: &str, payload: &str) {
    ctx.db.trip_events().insert(TripEvent {
        id: 0,
        trip_id,
        kind: kind.to_string(),
        payload: payload.to_string(),
        timestamp: ctx.timestamp,
    });
}

fn require_state(trip: &Trip, expected: &str) -> Result<(), String> {
    if trip.state != expected {
        return Err(format!(
            "illegal transition: trip {} is in state {}, expected {}",
            trip.id, trip.state, expected
        ));
    }
    Ok(())
}

fn find_trip(ctx: &ReducerContext, trip_id: u64) -> Result<Trip, String> {
    ctx.db
        .trips()
        .id()
        .find(trip_id)
        .ok_or_else(|| format!("trip {trip_id} not found"))
}

fn set_state(ctx: &ReducerContext, trip_id: u64, new_state: &str) -> Result<(), String> {
    let mut trip = find_trip(ctx, trip_id)?;
    trip.state = new_state.to_string();
    ctx.db.trips().id().update(trip);
    Ok(())
}

fn has_recommendation(ctx: &ReducerContext, trip_id: u64, kind: &str) -> bool {
    ctx.db
        .ai_recommendations()
        .iter()
        .any(|r| r.trip_id == trip_id && r.kind == kind)
}

// ---------------------------------------------------------------------------
// seed_demo_data
// ---------------------------------------------------------------------------

#[spacetimedb::reducer]
pub fn seed_demo_data(ctx: &ReducerContext) {
    // Clear everything so the reducer is idempotent and the demo can be reset.
    let ids: Vec<u64> = ctx.db.trip_events().iter().map(|r| r.id).collect();
    for id in ids {
        ctx.db.trip_events().id().delete(id);
    }
    let ids: Vec<u64> = ctx.db.telemetry().iter().map(|r| r.id).collect();
    for id in ids {
        ctx.db.telemetry().id().delete(id);
    }
    let ids: Vec<u64> = ctx.db.ai_recommendations().iter().map(|r| r.id).collect();
    for id in ids {
        ctx.db.ai_recommendations().id().delete(id);
    }
    let ids: Vec<u64> = ctx.db.trips().iter().map(|r| r.id).collect();
    for id in ids {
        ctx.db.trips().id().delete(id);
    }
    let ids: Vec<u64> = ctx.db.vehicles().iter().map(|r| r.id).collect();
    for id in ids {
        ctx.db.vehicles().id().delete(id);
    }
    let ids: Vec<u64> = ctx.db.residents().iter().map(|r| r.id).collect();
    for id in ids {
        ctx.db.residents().id().delete(id);
    }
    let ids: Vec<u64> = ctx.db.community().iter().map(|r| r.id).collect();
    for id in ids {
        ctx.db.community().id().delete(id);
    }

    // Community
    ctx.db.community().insert(Community {
        id: 1,
        name: "Microsoft Apartments".to_string(),
        teslas: 3,
        residents: 14,
        chargers: 2,
    });

    // Vehicles
    ctx.db.vehicles().insert(Vehicle {
        id: 0,
        model: "Tesla Model 3".to_string(),
        battery: 82,
        location: "Garage B2".to_string(),
        status: "Available".to_string(),
    });
    ctx.db.vehicles().insert(Vehicle {
        id: 0,
        model: "Tesla Model Y".to_string(),
        battery: 64,
        location: "Garage B1".to_string(),
        status: "Active Trip".to_string(),
    });
    ctx.db.vehicles().insert(Vehicle {
        id: 0,
        model: "Tesla Model S".to_string(),
        battery: 91,
        location: "Charging Stall 1".to_string(),
        status: "Charging".to_string(),
    });

    // Residents
    ctx.db.residents().insert(Resident {
        id: 0,
        name: "Franco".to_string(),
        voltscore: 91,
        status: "verified".to_string(),
    });
    ctx.db.residents().insert(Resident {
        id: 0,
        name: "Maya".to_string(),
        voltscore: 84,
        status: "verified".to_string(),
    });
    ctx.db.residents().insert(Resident {
        id: 0,
        name: "Alex".to_string(),
        voltscore: 0,
        status: "pending".to_string(),
    });

    log::info!("VoltPass demo data seeded");
}

// ---------------------------------------------------------------------------
// reserve_vehicle  (resident action)
//
// Opens the Trip Room and runs the deterministic check-in cascade
// (RESERVED -> CHECK_IN_STARTED -> VEHICLE_VERIFIED) including the vehicle
// telemetry snapshot. It deliberately STOPS at VEHICLE_VERIFIED and does NOT
// write any AI content — that is the AI Trust Agent's job, as a separate actor.
// ---------------------------------------------------------------------------

#[spacetimedb::reducer]
pub fn reserve_vehicle(
    ctx: &ReducerContext,
    vehicle_id: u64,
    renter: String,
) -> Result<(), String> {
    let mut vehicle = ctx
        .db
        .vehicles()
        .id()
        .find(vehicle_id)
        .ok_or_else(|| format!("vehicle {vehicle_id} not found"))?;

    if vehicle.status != "Available" {
        return Err(format!(
            "vehicle {} is not available (status: {})",
            vehicle.model, vehicle.status
        ));
    }

    // 1. RESERVED
    let trip = ctx.db.trips().insert(Trip {
        id: 0,
        vehicle_id,
        renter: renter.clone(),
        state: state::RESERVED.to_string(),
        created_at: ctx.timestamp,
    });
    vehicle.status = "Reserved".to_string();
    ctx.db.vehicles().id().update(vehicle.clone());
    log_event(
        ctx,
        trip.id,
        "RESERVED",
        &format!("{} reserved {}", renter, vehicle.model),
    );

    // 2. CHECK_IN_STARTED
    set_state(ctx, trip.id, state::CHECK_IN_STARTED)?;
    log_event(ctx, trip.id, "CHECK_IN_STARTED", "Resident started check-in");

    // 3. Vehicle snapshot -> VEHICLE_VERIFIED (telemetry, not AI)
    ctx.db.telemetry().insert(Telemetry {
        id: 0,
        trip_id: trip.id,
        battery: vehicle.battery,
        odometer_delta: 0.0,
        harsh_brake: false,
        geofence_ok: true,
        timestamp: ctx.timestamp,
    });
    set_state(ctx, trip.id, state::VEHICLE_VERIFIED)?;
    log_event(
        ctx,
        trip.id,
        "VEHICLE_VERIFIED",
        &format!(
            "Snapshot captured at {}% battery in {}",
            vehicle.battery, vehicle.location
        ),
    );

    Ok(())
}

// ---------------------------------------------------------------------------
// ai_write_recommendation  (AI Trust Agent action — PERSIST ONLY)
//
// The agent decides the verdict and body (optionally via an LLM) outside the
// database. This reducer only persists the structured row it is handed and
// appends a timeline event. It is idempotent per (trip, kind) so the standalone
// agent and the owner-side fallback can never produce a duplicate.
// ---------------------------------------------------------------------------

#[spacetimedb::reducer]
pub fn ai_write_recommendation(
    ctx: &ReducerContext,
    trip_id: u64,
    kind: String,
    verdict: String,
    body: String,
) -> Result<(), String> {
    // Validate the trip exists; the agent should only write for real trips.
    let _ = find_trip(ctx, trip_id)?;

    if has_recommendation(ctx, trip_id, &kind) {
        // Already written by another actor — no-op (idempotent).
        return Ok(());
    }

    ctx.db.ai_recommendations().insert(AiRecommendation {
        id: 0,
        trip_id,
        kind: kind.clone(),
        verdict,
        body,
        created_at: ctx.timestamp,
    });

    let event_kind = if kind == "unlock" {
        "AI_UNLOCK_RECOMMENDATION"
    } else {
        "AI_RECOMMENDATION"
    };
    log_event(
        ctx,
        trip_id,
        event_kind,
        "AI Trust Agent wrote a recommendation into SpacetimeDB",
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// approve_unlock  (owner action)
// ---------------------------------------------------------------------------

#[spacetimedb::reducer]
pub fn approve_unlock(ctx: &ReducerContext, trip_id: u64) -> Result<(), String> {
    let trip = find_trip(ctx, trip_id)?;
    require_state(&trip, state::VEHICLE_VERIFIED)?;

    set_state(ctx, trip_id, state::UNLOCK_GRANTED)?;
    log_event(ctx, trip_id, "UNLOCK_GRANTED", "Owner approved unlock");

    // Activate the trip and flip the vehicle to Active Trip.
    set_state(ctx, trip_id, state::TRIP_ACTIVE)?;
    if let Some(mut v) = ctx.db.vehicles().id().find(trip.vehicle_id) {
        v.status = "Active Trip".to_string();
        ctx.db.vehicles().id().update(v);
    }
    log_event(ctx, trip_id, "TRIP_ACTIVE", "Trip is now active");
    Ok(())
}

// ---------------------------------------------------------------------------
// push_telemetry  (telemetry simulator action — the owner's vehicle connector)
//
// Each row updates the live vehicle battery and writes a trip event.
// ---------------------------------------------------------------------------

#[spacetimedb::reducer]
pub fn push_telemetry(
    ctx: &ReducerContext,
    trip_id: u64,
    battery: i32,
    odometer_delta: f32,
    harsh_brake: bool,
    geofence_ok: bool,
) -> Result<(), String> {
    let trip = find_trip(ctx, trip_id)?;
    require_state(&trip, state::TRIP_ACTIVE)?;

    ctx.db.telemetry().insert(Telemetry {
        id: 0,
        trip_id,
        battery,
        odometer_delta,
        harsh_brake,
        geofence_ok,
        timestamp: ctx.timestamp,
    });

    if let Some(mut v) = ctx.db.vehicles().id().find(trip.vehicle_id) {
        v.battery = battery;
        ctx.db.vehicles().id().update(v);
    }

    let mut payload = format!("+{odometer_delta:.1} mi, battery {battery}%");
    if harsh_brake {
        payload.push_str(", HARSH BRAKE detected");
    }
    if !geofence_ok {
        payload.push_str(", GEOFENCE breach");
    }
    log_event(ctx, trip_id, "TELEMETRY", &payload);
    Ok(())
}

// ---------------------------------------------------------------------------
// start_return  (resident action)
//
// Moves the trip into AI_REVIEWING and STOPS. This is the signal for the AI
// Trust Agent to read the telemetry and write the closeout.
// ---------------------------------------------------------------------------

#[spacetimedb::reducer]
pub fn start_return(ctx: &ReducerContext, trip_id: u64) -> Result<(), String> {
    let trip = find_trip(ctx, trip_id)?;
    require_state(&trip, state::TRIP_ACTIVE)?;

    set_state(ctx, trip_id, state::RETURN_STARTED)?;
    log_event(ctx, trip_id, "RETURN_STARTED", "Resident started return");

    set_state(ctx, trip_id, state::AI_REVIEWING)?;
    log_event(ctx, trip_id, "AI_REVIEWING", "Awaiting AI Trust Agent closeout");
    Ok(())
}

// ---------------------------------------------------------------------------
// generate_closeout  (AI Trust Agent action — PERSIST ONLY + close trip)
//
// The agent computes the closeout (from telemetry, optionally via an LLM) and
// hands the result here. This reducer only persists the structured row, then
// performs the deterministic AI_REVIEWING -> CLOSED transition and frees the
// vehicle. Idempotent: if a closeout already exists it is a no-op.
// ---------------------------------------------------------------------------

#[spacetimedb::reducer]
pub fn generate_closeout(
    ctx: &ReducerContext,
    trip_id: u64,
    verdict: String,
    body: String,
) -> Result<(), String> {
    let trip = find_trip(ctx, trip_id)?;

    if has_recommendation(ctx, trip_id, "closeout") {
        return Ok(()); // already closed out by another actor
    }
    require_state(&trip, state::AI_REVIEWING)?;

    ctx.db.ai_recommendations().insert(AiRecommendation {
        id: 0,
        trip_id,
        kind: "closeout".to_string(),
        verdict,
        body,
        created_at: ctx.timestamp,
    });
    log_event(
        ctx,
        trip_id,
        "AI_CLOSEOUT",
        "AI Trust Agent wrote closeout report into SpacetimeDB",
    );

    // The closeout being written is what closes the trip.
    set_state(ctx, trip_id, state::CLOSED)?;
    if let Some(mut v) = ctx.db.vehicles().id().find(trip.vehicle_id) {
        v.status = "Available".to_string();
        ctx.db.vehicles().id().update(v);
    }
    log_event(ctx, trip_id, "CLOSED", "Trip closed");
    Ok(())
}
