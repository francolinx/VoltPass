// Row TYPES derived from the generated SpacetimeDB type builders.
// The generated `module_bindings` export each table type as a runtime *value*
// (a type builder); `Infer<typeof X>` turns it into the corresponding TS type.
import type { Infer } from "spacetimedb";
import {
  Vehicle as VehicleDef,
  Resident as ResidentDef,
  Trip as TripDef,
  TripEvent as TripEventDef,
  Telemetry as TelemetryDef,
  AiRecommendation as AiRecommendationDef,
  Community as CommunityDef,
} from "./module_bindings";

export type Vehicle = Infer<typeof VehicleDef>;
export type Resident = Infer<typeof ResidentDef>;
export type Trip = Infer<typeof TripDef>;
export type TripEvent = Infer<typeof TripEventDef>;
export type Telemetry = Infer<typeof TelemetryDef>;
export type AiRecommendation = Infer<typeof AiRecommendationDef>;
export type Community = Infer<typeof CommunityDef>;
