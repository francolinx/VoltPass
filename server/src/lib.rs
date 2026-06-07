//! VoltPass — Real-time Trust OS for resident-only EV sharing.
//!
//! SpacetimeDB is the live "Trip Room" ledger. Every meaningful state change in
//! the trip lifecycle — reservation, vehicle snapshot, AI recommendation, unlock,
//! telemetry, return and closeout — moves through one authoritative shared state
//! here, and is streamed to every subscribed client in real time.
//!
//! ARCHITECTURE NOTES
//!
//! * Reducers are sandboxed. They NEVER make outbound HTTP/LLM/Smartcar calls.
//!   They only validate state transitions and persist data passed into them.
//!
//! * The AI Trust Agent is a separate actor (`agent/`) that subscribes to this
//!   state, decides when an artifact is needed, optionally calls an LLM, and
//!   writes its structured result back through `ai_write_recommendation` /
//!   `generate_closeout`.
//!
//! * Real vehicle data/control comes from Smartcar, fetched by a server-side
//!   connector (`api/`) — never from a reducer, and never with secrets in the
//!   frontend. The connector calls Smartcar, then persists the results here via
//!   `connect_smartcar_vehicle`, `ingest_smartcar_snapshot`,
//!   `record_unlock_command` and `confirm_unlock_status`. A simulator path
//!   remains available as a fallback.
//!
//! The actors writing to this shared state are therefore: the resident, the
//! owner, the telemetry simulator, the Smartcar connector, and the AI Trust
//! Agent — all distinct, all authoritative through reducers.

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
// Tables  (all `public` so the browser clients, agent and connector subscribe)
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
    // Live state (latest snapshot; from simulator or Smartcar)
    pub source: String, // simulator | smartcar_live
    pub latitude: f64,
    pub longitude: f64,
    pub location_confirmed: bool,
    pub lock_status: String,   // locked | unlocked | unlocking | unknown
    pub charge_status: String, // charging | not_charging | unknown
    pub smartcar_vehicle_id: String,
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
    // Provenance + (optional) live location for the trip stream.
    pub source: String, // simulator | smartcar_live
    pub latitude: f64,
    pub longitude: f64,
    pub location_confirmed: bool,
    pub lock_status: String,
}

/// Rich point-in-time vehicle snapshots (pre-trip or during a trip), from the
/// simulator or live Smartcar. The audit log behind the live `vehicles` fields.
#[spacetimedb::table(name = vehicle_snapshots, public)]
#[derive(Clone)]
pub struct VehicleSnapshot {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub vehicle_id: u64,
    pub trip_id: u64, // 0 if captured outside a trip
    pub source: String,
    pub battery_pct: i32,
    pub odometer: f64,
    pub latitude: f64,
    pub longitude: f64,
    pub location_confirmed: bool,
    pub lock_status: String,
    pub charge_status: String,
    pub smartcar_vehicle_id: String,
    pub captured_at: Timestamp,
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
    for id in ctx.db.trip_events().iter().map(|r| r.id).collect::<Vec<_>>() {
        ctx.db.trip_events().id().delete(id);
    }
    for id in ctx.db.telemetry().iter().map(|r| r.id).collect::<Vec<_>>() {
        ctx.db.telemetry().id().delete(id);
    }
    for id in ctx.db.vehicle_snapshots().iter().map(|r| r.id).collect::<Vec<_>>() {
        ctx.db.vehicle_snapshots().id().delete(id);
    }
    for id in ctx.db.ai_recommendations().iter().map(|r| r.id).collect::<Vec<_>>() {
        ctx.db.ai_recommendations().id().delete(id);
    }
    for id in ctx.db.trips().iter().map(|r| r.id).collect::<Vec<_>>() {
        ctx.db.trips().id().delete(id);
    }
    for id in ctx.db.vehicles().iter().map(|r| r.id).collect::<Vec<_>>() {
        ctx.db.vehicles().id().delete(id);
    }
    for id in ctx.db.residents().iter().map(|r| r.id).collect::<Vec<_>>() {
        ctx.db.residents().id().delete(id);
    }
    for id in ctx.db.community().iter().map(|r| r.id).collect::<Vec<_>>() {
        ctx.db.community().id().delete(id);
    }

    ctx.db.community().insert(Community {
        id: 1,
        name: "Microsoft Apartments".to_string(),
        teslas: 3,
        residents: 14,
        chargers: 2,
    });

    let mk = |model: &str, battery: i32, location: &str, status: &str, charge: &str| Vehicle {
        id: 0,
        model: model.to_string(),
        battery,
        location: location.to_string(),
        status: status.to_string(),
        source: "simulator".to_string(),
        latitude: 0.0,
        longitude: 0.0,
        location_confirmed: true,
        lock_status: "locked".to_string(),
        charge_status: charge.to_string(),
        smartcar_vehicle_id: String::new(),
    };
    ctx.db.vehicles().insert(mk("Tesla Model 3", 82, "Garage B2", "Available", "not_charging"));
    ctx.db.vehicles().insert(mk("Tesla Model Y", 64, "Garage B1", "Active Trip", "not_charging"));
    ctx.db.vehicles().insert(mk("Tesla Model S", 91, "Charging Stall 1", "Charging", "charging"));

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
// (RESERVED -> CHECK_IN_STARTED -> VEHICLE_VERIFIED) including a vehicle
// telemetry snapshot taken from the vehicle's CURRENT live state (which may have
// just been refreshed from Smartcar). Stops at VEHICLE_VERIFIED; writes no AI.
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

    set_state(ctx, trip.id, state::CHECK_IN_STARTED)?;
    log_event(ctx, trip.id, "CHECK_IN_STARTED", "Resident started check-in");

    // Snapshot from current live vehicle state (telemetry, not AI).
    ctx.db.telemetry().insert(Telemetry {
        id: 0,
        trip_id: trip.id,
        battery: vehicle.battery,
        odometer_delta: 0.0,
        harsh_brake: false,
        geofence_ok: vehicle.location_confirmed,
        timestamp: ctx.timestamp,
        source: vehicle.source.clone(),
        latitude: vehicle.latitude,
        longitude: vehicle.longitude,
        location_confirmed: vehicle.location_confirmed,
        lock_status: vehicle.lock_status.clone(),
    });
    set_state(ctx, trip.id, state::VEHICLE_VERIFIED)?;
    let src = if vehicle.source == "smartcar_live" { " (Smartcar live)" } else { "" };
    log_event(
        ctx,
        trip.id,
        "VEHICLE_VERIFIED",
        &format!(
            "Snapshot captured at {}% battery in {}{}",
            vehicle.battery, vehicle.location, src
        ),
    );

    Ok(())
}

// ---------------------------------------------------------------------------
// ai_write_recommendation  (AI Trust Agent — PERSIST ONLY, idempotent)
// ---------------------------------------------------------------------------

#[spacetimedb::reducer]
pub fn ai_write_recommendation(
    ctx: &ReducerContext,
    trip_id: u64,
    kind: String,
    verdict: String,
    body: String,
) -> Result<(), String> {
    let _ = find_trip(ctx, trip_id)?;
    if has_recommendation(ctx, trip_id, &kind) {
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

    set_state(ctx, trip_id, state::TRIP_ACTIVE)?;
    if let Some(mut v) = ctx.db.vehicles().id().find(trip.vehicle_id) {
        v.status = "Active Trip".to_string();
        ctx.db.vehicles().id().update(v);
    }
    log_event(ctx, trip_id, "TRIP_ACTIVE", "Trip is now active");
    Ok(())
}

// ---------------------------------------------------------------------------
// push_telemetry  (telemetry simulator — the owner's "Simulate Trip" connector)
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
        source: "simulator".to_string(),
        latitude: 0.0,
        longitude: 0.0,
        location_confirmed: geofence_ok,
        lock_status: "unlocked".to_string(),
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
// start_return  (resident action) -> AI_REVIEWING (stops; agent writes closeout)
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
// generate_closeout  (AI Trust Agent — PERSIST ONLY + close trip, idempotent)
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
        return Ok(());
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

    set_state(ctx, trip_id, state::CLOSED)?;
    if let Some(mut v) = ctx.db.vehicles().id().find(trip.vehicle_id) {
        v.status = "Available".to_string();
        ctx.db.vehicles().id().update(v);
    }
    log_event(ctx, trip_id, "CLOSED", "Trip closed");
    Ok(())
}

// ===========================================================================
// Smartcar connector reducers (PERSIST ONLY)
//
// The server-side Smartcar connector (`api/`) performs all OAuth + Smartcar API
// work, then hands the results to these reducers. No reducer ever talks to
// Smartcar directly.
// ===========================================================================

/// Register / refresh a real Smartcar-connected vehicle in the fleet. Upserts by
/// `smartcar_vehicle_id`. Used after Smartcar Connect lists connected vehicles.
#[spacetimedb::reducer]
pub fn connect_smartcar_vehicle(
    ctx: &ReducerContext,
    smartcar_vehicle_id: String,
    model: String,
    label: String,
) -> Result<(), String> {
    if smartcar_vehicle_id.is_empty() {
        return Err("smartcar_vehicle_id required".to_string());
    }
    let existing = ctx
        .db
        .vehicles()
        .iter()
        .find(|v| v.smartcar_vehicle_id == smartcar_vehicle_id);

    if let Some(mut v) = existing {
        v.model = model;
        v.source = "smartcar_live".to_string();
        if !label.is_empty() {
            v.location = label;
        }
        ctx.db.vehicles().id().update(v);
    } else {
        ctx.db.vehicles().insert(Vehicle {
            id: 0,
            model,
            battery: 0,
            location: if label.is_empty() { "Smartcar".to_string() } else { label },
            status: "Available".to_string(),
            source: "smartcar_live".to_string(),
            latitude: 0.0,
            longitude: 0.0,
            location_confirmed: false,
            lock_status: "unknown".to_string(),
            charge_status: "unknown".to_string(),
            smartcar_vehicle_id,
        });
    }
    Ok(())
}

/// Persist a live snapshot (from Smartcar or the simulator) for a vehicle.
/// Updates the vehicle's live fields, appends a `vehicle_snapshots` audit row,
/// and — if a trip is active for the vehicle — appends a trip telemetry row.
#[spacetimedb::reducer]
#[allow(clippy::too_many_arguments)]
pub fn ingest_smartcar_snapshot(
    ctx: &ReducerContext,
    vehicle_id: u64,
    trip_id: u64,
    source: String,
    battery_pct: i32,
    odometer: f64,
    latitude: f64,
    longitude: f64,
    location_confirmed: bool,
    lock_status: String,
    charge_status: String,
    smartcar_vehicle_id: String,
) -> Result<(), String> {
    let mut vehicle = ctx
        .db
        .vehicles()
        .id()
        .find(vehicle_id)
        .ok_or_else(|| format!("vehicle {vehicle_id} not found"))?;

    // Update the live vehicle state.
    vehicle.battery = battery_pct;
    vehicle.source = source.clone();
    vehicle.latitude = latitude;
    vehicle.longitude = longitude;
    vehicle.location_confirmed = location_confirmed;
    vehicle.location = if location_confirmed {
        "Community Garage".to_string()
    } else {
        "Off-site".to_string()
    };
    vehicle.lock_status = lock_status.clone();
    vehicle.charge_status = charge_status.clone();
    if !smartcar_vehicle_id.is_empty() {
        vehicle.smartcar_vehicle_id = smartcar_vehicle_id.clone();
    }
    ctx.db.vehicles().id().update(vehicle.clone());

    // Audit snapshot.
    ctx.db.vehicle_snapshots().insert(VehicleSnapshot {
        id: 0,
        vehicle_id,
        trip_id,
        source: source.clone(),
        battery_pct,
        odometer,
        latitude,
        longitude,
        location_confirmed,
        lock_status: lock_status.clone(),
        charge_status,
        smartcar_vehicle_id,
        captured_at: ctx.timestamp,
    });

    // If a trip is active for this vehicle, also record it on the trip stream.
    if trip_id != 0 {
        if let Some(trip) = ctx.db.trips().id().find(trip_id) {
            if trip.state == state::TRIP_ACTIVE {
                ctx.db.telemetry().insert(Telemetry {
                    id: 0,
                    trip_id,
                    battery: battery_pct,
                    odometer_delta: 0.0,
                    harsh_brake: false,
                    geofence_ok: location_confirmed,
                    timestamp: ctx.timestamp,
                    source: source.clone(),
                    latitude,
                    longitude,
                    location_confirmed,
                    lock_status: lock_status.clone(),
                });
            }
            let conf = if location_confirmed { "confirmed" } else { "NOT confirmed" };
            log_event(
                ctx,
                trip_id,
                "SMARTCAR_SNAPSHOT",
                &format!("Smartcar snapshot: {battery_pct}% battery, location {conf}, {lock_status}"),
            );
        }
    }
    Ok(())
}

/// Record that an unlock command was sent to the vehicle (via Smartcar). Sets the
/// lock status to a transitional value and logs the command on the trip.
#[spacetimedb::reducer]
pub fn record_unlock_command(
    ctx: &ReducerContext,
    trip_id: u64,
    vehicle_id: u64,
    command_status: String,
) -> Result<(), String> {
    if let Some(mut v) = ctx.db.vehicles().id().find(vehicle_id) {
        v.lock_status = "unlocking".to_string();
        ctx.db.vehicles().id().update(v);
    }
    if trip_id != 0 {
        log_event(
            ctx,
            trip_id,
            "UNLOCK_COMMAND",
            &format!("Smartcar unlock command: {command_status}"),
        );
    }
    Ok(())
}

/// Confirm the post-command lock status read back from Smartcar.
#[spacetimedb::reducer]
pub fn confirm_unlock_status(
    ctx: &ReducerContext,
    trip_id: u64,
    vehicle_id: u64,
    lock_status: String,
) -> Result<(), String> {
    if let Some(mut v) = ctx.db.vehicles().id().find(vehicle_id) {
        v.lock_status = lock_status.clone();
        ctx.db.vehicles().id().update(v);
    }
    if trip_id != 0 {
        log_event(
            ctx,
            trip_id,
            "UNLOCK_CONFIRMED",
            &format!("Vehicle lock status confirmed: {lock_status}"),
        );
    }
    Ok(())
}
