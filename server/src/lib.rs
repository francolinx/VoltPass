//! VoltPass — Real-time Trust OS for resident-only EV sharing.
//!
//! SpacetimeDB is the live "Trip Room" ledger. Every meaningful state change in
//! the trip lifecycle — reservation, vehicle snapshot, AI recommendation, unlock,
//! telemetry, return and closeout — moves through one authoritative shared state
//! here, and is streamed to every subscribed client (the /resident and /owner
//! windows) in real time.

use spacetimedb::{ReducerContext, Table, Timestamp};

// ---------------------------------------------------------------------------
// Trip Room state machine
// ---------------------------------------------------------------------------
//
// AVAILABLE
//   -> RESERVED
//   -> CHECK_IN_STARTED
//   -> VEHICLE_VERIFIED      (snapshot ingested, AI unlock recommendation written)
//   -> UNLOCK_GRANTED
//   -> TRIP_ACTIVE
//   -> RETURN_STARTED
//   -> AI_REVIEWING          (AI closeout report written)
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
// Tables  (all `public` so the browser clients can subscribe to them)
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
    pub verdict: String, // APPROVE | CLEAN_CLOSE | REVIEW
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
// reserve_vehicle
//
// Creates the Trip Room and runs the automatic check-in cascade so that, the
// instant a resident reserves, the owner window lights up with: the reservation,
// a simulated vehicle telemetry snapshot, and the AI unlock recommendation.
// Trip lands in VEHICLE_VERIFIED, awaiting the owner's approval.
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

    // 3. Vehicle snapshot -> VEHICLE_VERIFIED
    ingest_snapshot_internal(ctx, trip.id, &vehicle)?;

    // 4. AI unlock recommendation
    write_unlock_recommendation(ctx, &trip, &vehicle, &renter);

    Ok(())
}

fn set_state(ctx: &ReducerContext, trip_id: u64, new_state: &str) -> Result<(), String> {
    let mut trip = find_trip(ctx, trip_id)?;
    trip.state = new_state.to_string();
    ctx.db.trips().id().update(trip);
    Ok(())
}

fn ingest_snapshot_internal(
    ctx: &ReducerContext,
    trip_id: u64,
    vehicle: &Vehicle,
) -> Result<(), String> {
    ctx.db.telemetry().insert(Telemetry {
        id: 0,
        trip_id,
        battery: vehicle.battery,
        odometer_delta: 0.0,
        harsh_brake: false,
        geofence_ok: true,
        timestamp: ctx.timestamp,
    });
    set_state(ctx, trip_id, state::VEHICLE_VERIFIED)?;
    log_event(
        ctx,
        trip_id,
        "VEHICLE_VERIFIED",
        &format!(
            "Snapshot captured at {}% battery in {}",
            vehicle.battery, vehicle.location
        ),
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// AI Trust Agent — writes structured recommendations into shared state.
// It is not a chatbot: it reads trip + telemetry and writes rows that humans
// and the UI act on.
// ---------------------------------------------------------------------------

fn write_unlock_recommendation(
    ctx: &ReducerContext,
    trip: &Trip,
    vehicle: &Vehicle,
    renter: &str,
) {
    let resident = ctx.db.residents().iter().find(|r| r.name == renter);
    let (verified, score) = match resident {
        Some(r) => (r.status == "verified", r.voltscore),
        None => (false, 0),
    };

    let body = if verified {
        format!(
            "Approve unlock. {renter} is a verified resident with VoltScore {score}. \
             Vehicle snapshot captured at {}% battery in {}. No active disputes. Unlock recommended.",
            vehicle.battery, vehicle.location
        )
    } else {
        format!(
            "Hold unlock. {renter} is not a fully verified resident. \
             Manual review recommended before granting access to {}.",
            vehicle.model
        )
    };
    let verdict = if verified { "APPROVE" } else { "REVIEW" };

    ctx.db.ai_recommendations().insert(AiRecommendation {
        id: 0,
        trip_id: trip.id,
        kind: "unlock".to_string(),
        verdict: verdict.to_string(),
        body,
        created_at: ctx.timestamp,
    });
    log_event(
        ctx,
        trip.id,
        "AI_UNLOCK_RECOMMENDATION",
        "AI Trust Agent wrote unlock recommendation",
    );
}

// ---------------------------------------------------------------------------
// Explicit step reducers (also usable individually / for testing)
// ---------------------------------------------------------------------------

#[spacetimedb::reducer]
pub fn start_checkin(ctx: &ReducerContext, trip_id: u64) -> Result<(), String> {
    let trip = find_trip(ctx, trip_id)?;
    require_state(&trip, state::RESERVED)?;
    set_state(ctx, trip_id, state::CHECK_IN_STARTED)?;
    log_event(ctx, trip_id, "CHECK_IN_STARTED", "Resident started check-in");
    Ok(())
}

#[spacetimedb::reducer]
pub fn ingest_vehicle_snapshot(ctx: &ReducerContext, trip_id: u64) -> Result<(), String> {
    let trip = find_trip(ctx, trip_id)?;
    require_state(&trip, state::CHECK_IN_STARTED)?;
    let vehicle = ctx
        .db
        .vehicles()
        .id()
        .find(trip.vehicle_id)
        .ok_or("vehicle not found")?;
    ingest_snapshot_internal(ctx, trip_id, &vehicle)
}

#[spacetimedb::reducer]
pub fn ai_write_recommendation(ctx: &ReducerContext, trip_id: u64) -> Result<(), String> {
    let trip = find_trip(ctx, trip_id)?;
    require_state(&trip, state::VEHICLE_VERIFIED)?;
    let vehicle = ctx
        .db
        .vehicles()
        .id()
        .find(trip.vehicle_id)
        .ok_or("vehicle not found")?;
    let renter = trip.renter.clone();
    write_unlock_recommendation(ctx, &trip, &vehicle, &renter);
    Ok(())
}

/// Owner approves the unlock. Grants access and immediately activates the trip.
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

/// Standalone trip activation (kept for completeness / manual stepping).
#[spacetimedb::reducer]
pub fn start_trip(ctx: &ReducerContext, trip_id: u64) -> Result<(), String> {
    let trip = find_trip(ctx, trip_id)?;
    require_state(&trip, state::UNLOCK_GRANTED)?;
    set_state(ctx, trip_id, state::TRIP_ACTIVE)?;
    if let Some(mut v) = ctx.db.vehicles().id().find(trip.vehicle_id) {
        v.status = "Active Trip".to_string();
        ctx.db.vehicles().id().update(v);
    }
    log_event(ctx, trip_id, "TRIP_ACTIVE", "Trip is now active");
    Ok(())
}

// ---------------------------------------------------------------------------
// push_telemetry — simulator-backed vehicle connector.
// The owner's "Simulate Trip" button streams these rows in through SpacetimeDB.
// Each row also updates the live vehicle battery and writes a trip event.
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
// Return + AI closeout cascade
// ---------------------------------------------------------------------------

/// Resident starts the return. This runs the closeout cascade:
/// RETURN_STARTED -> AI_REVIEWING (AI writes closeout from telemetry) -> CLOSED.
#[spacetimedb::reducer]
pub fn start_return(ctx: &ReducerContext, trip_id: u64) -> Result<(), String> {
    let trip = find_trip(ctx, trip_id)?;
    require_state(&trip, state::TRIP_ACTIVE)?;

    set_state(ctx, trip_id, state::RETURN_STARTED)?;
    log_event(ctx, trip_id, "RETURN_STARTED", "Resident started return");

    generate_closeout_internal(ctx, trip_id)?;
    close_trip_internal(ctx, trip_id)?;
    Ok(())
}

fn generate_closeout_internal(ctx: &ReducerContext, trip_id: u64) -> Result<(), String> {
    set_state(ctx, trip_id, state::AI_REVIEWING)?;
    log_event(ctx, trip_id, "AI_REVIEWING", "AI Trust Agent reviewing trip");

    // Build the closeout report from the actual telemetry rows for this trip.
    let mut rows: Vec<Telemetry> = ctx
        .db
        .telemetry()
        .iter()
        .filter(|t| t.trip_id == trip_id)
        .collect();
    rows.sort_by_key(|r| r.id);

    let body;
    let verdict;
    if rows.is_empty() {
        // Hardcoded fallback so the demo never depends on data being present.
        body = "Trip closed cleanly. Battery moved from 82% to 61%, odometer increased \
                14.2 miles, one harsh braking event detected, geofence OK. Recommend clean \
                closeout with minor battery adjustment."
            .to_string();
        verdict = "CLEAN_CLOSE".to_string();
    } else {
        let start_battery = rows.first().map(|r| r.battery).unwrap_or(0);
        let end_battery = rows.last().map(|r| r.battery).unwrap_or(0);
        let miles: f32 = rows.iter().map(|r| r.odometer_delta).sum();
        let harsh = rows.iter().filter(|r| r.harsh_brake).count();
        let geofence_ok = rows.iter().all(|r| r.geofence_ok);

        let harsh_str = match harsh {
            0 => "no harsh braking events".to_string(),
            1 => "one harsh braking event detected".to_string(),
            n => format!("{n} harsh braking events detected"),
        };
        let geofence_str = if geofence_ok { "geofence OK" } else { "geofence FLAGGED" };
        verdict = if geofence_ok && harsh <= 1 {
            "CLEAN_CLOSE".to_string()
        } else {
            "REVIEW".to_string()
        };

        body = format!(
            "Trip closed cleanly. Battery moved from {start_battery}% to {end_battery}%, \
             odometer increased {miles:.1} miles, {harsh_str}, {geofence_str}. \
             Recommend clean closeout with minor battery adjustment."
        );
    }

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
        "AI Trust Agent wrote closeout report",
    );
    Ok(())
}

fn close_trip_internal(ctx: &ReducerContext, trip_id: u64) -> Result<(), String> {
    let trip = find_trip(ctx, trip_id)?;
    set_state(ctx, trip_id, state::CLOSED)?;
    if let Some(mut v) = ctx.db.vehicles().id().find(trip.vehicle_id) {
        v.status = "Available".to_string();
        ctx.db.vehicles().id().update(v);
    }
    log_event(ctx, trip_id, "CLOSED", "Trip closed");
    Ok(())
}

/// Standalone closeout generation (kept for manual stepping).
#[spacetimedb::reducer]
pub fn generate_closeout(ctx: &ReducerContext, trip_id: u64) -> Result<(), String> {
    let trip = find_trip(ctx, trip_id)?;
    require_state(&trip, state::RETURN_STARTED)?;
    generate_closeout_internal(ctx, trip_id)
}

/// Standalone trip close (kept for manual stepping).
#[spacetimedb::reducer]
pub fn close_trip(ctx: &ReducerContext, trip_id: u64) -> Result<(), String> {
    let trip = find_trip(ctx, trip_id)?;
    require_state(&trip, state::AI_REVIEWING)?;
    close_trip_internal(ctx, trip_id)
}
