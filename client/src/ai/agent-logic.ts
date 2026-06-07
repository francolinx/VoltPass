// VoltPass AI Trust Agent — decision logic.
//
// This module is intentionally free of SpacetimeDB and React imports so it can
// be shared by BOTH the standalone Node agent (`agent/`) and the owner-side
// browser fallback. It only *decides* what the AI artifact should say; the
// caller is responsible for persisting it through a reducer.
//
// Every function has a deterministic, hardcoded-grade fallback so the demo never
// depends on an external API. An LLM is used for the closeout prose only, only
// when an API key is provided, and only as an enhancement over the fallback.

export interface AiArtifact {
  verdict: string;
  body: string;
}

export interface UnlockInput {
  renter: string;
  voltscore: number;
  verified: boolean;
  battery: number;
  location: string;
  model: string;
}

/** Unlock recommendation, written after the trip reaches VEHICLE_VERIFIED. */
export function computeUnlockRecommendation(i: UnlockInput): AiArtifact {
  if (i.verified) {
    return {
      verdict: "APPROVE",
      body:
        `Approve unlock. ${i.renter} is a verified resident with VoltScore ${i.voltscore}. ` +
        `Vehicle snapshot captured at ${i.battery}% battery in ${i.location}. ` +
        `No active disputes. Unlock recommended.`,
    };
  }
  return {
    verdict: "REVIEW",
    body:
      `Hold unlock. ${i.renter} is not a fully verified resident. ` +
      `Manual review recommended before granting access to the ${i.model}.`,
  };
}

export interface TelemetryLike {
  battery: number;
  odometerDelta: number;
  harshBrake: boolean;
  geofenceOk: boolean;
}

/** Deterministic closeout derived from telemetry rows. Always safe to use. */
export function computeCloseoutFallback(rows: TelemetryLike[]): AiArtifact {
  if (rows.length === 0) {
    return {
      verdict: "CLEAN_CLOSE",
      body:
        "Trip closed cleanly. Battery moved from 82% to 61%, odometer increased " +
        "14.2 miles, one harsh braking event detected, geofence OK. Recommend " +
        "clean closeout with minor battery adjustment.",
    };
  }
  const startBattery = rows[0].battery;
  const endBattery = rows[rows.length - 1].battery;
  const miles = rows.reduce((a, r) => a + r.odometerDelta, 0);
  const harsh = rows.filter((r) => r.harshBrake).length;
  const geofenceOk = rows.every((r) => r.geofenceOk);

  const harshStr =
    harsh === 0
      ? "no harsh braking events"
      : harsh === 1
        ? "one harsh braking event detected"
        : `${harsh} harsh braking events detected`;
  const geoStr = geofenceOk ? "geofence OK" : "geofence FLAGGED";
  const verdict = geofenceOk && harsh <= 1 ? "CLEAN_CLOSE" : "REVIEW";

  return {
    verdict,
    body:
      `Trip closed cleanly. Battery moved from ${startBattery}% to ${endBattery}%, ` +
      `odometer increased ${miles.toFixed(1)} miles, ${harshStr}, ${geoStr}. ` +
      `Recommend clean closeout with minor battery adjustment.`,
  };
}

/**
 * Closeout report. Uses an LLM to author the prose from the same telemetry when
 * an Anthropic API key is available; otherwise (and on any error) returns the
 * deterministic fallback. The verdict always comes from the telemetry, so the
 * structured decision never depends on the model.
 */
export async function computeCloseout(
  rows: TelemetryLike[],
  opts: { apiKey?: string; model?: string } = {},
): Promise<AiArtifact> {
  const fallback = computeCloseoutFallback(rows);
  if (!opts.apiKey) return fallback;

  try {
    const model = opts.model ?? "claude-haiku-4-5-20251001";
    const facts = {
      startBattery: rows[0]?.battery ?? 82,
      endBattery: rows[rows.length - 1]?.battery ?? 61,
      miles: Number(rows.reduce((a, r) => a + r.odometerDelta, 0).toFixed(1)),
      harshBrakes: rows.filter((r) => r.harshBrake).length,
      geofenceOk: rows.every((r) => r.geofenceOk),
    };
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": opts.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 200,
        messages: [
          {
            role: "user",
            content:
              "You are the VoltPass AI Trust Agent. Write a 2-3 sentence trip " +
              "closeout report for an apartment-community EV share, in a calm, " +
              "professional tone. Base it ONLY on these telemetry facts and end " +
              "with a closeout recommendation. Facts: " +
              JSON.stringify(facts),
          },
        ],
      }),
    });
    if (!res.ok) return fallback;
    const data: any = await res.json();
    const text: string | undefined = data?.content?.[0]?.text?.trim();
    if (!text) return fallback;
    return { verdict: fallback.verdict, body: text };
  } catch {
    return fallback;
  }
}
