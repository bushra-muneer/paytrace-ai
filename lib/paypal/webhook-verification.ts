import { createHmac, timingSafeEqual } from "crypto";
import type { WebhookVerificationResult } from "@/lib/domain/types";
import { paypalRequest } from "@/lib/paypal/client";

// Real events are checked with PayPal's verify-webhook-signature API.
// Local test events (scripts/simulate-webhook.mjs) use an HMAC with
// PAYTRACE_SIMULATED_WEBHOOK_SECRET, and that path is off in production.

export const SIMULATION_SIGNATURE_HEADER = "x-paytrace-simulation-signature";
export const SIMULATION_TIMESTAMP_HEADER = "x-paytrace-simulation-timestamp";

const SIMULATION_MAX_SKEW_MS = 5 * 60 * 1000;

export type VerificationOutcome =
  | { ok: true; result: WebhookVerificationResult }
  | { ok: false; reason: string };

export async function verifyWebhookRequest(
  headers: Headers,
  rawBody: string
): Promise<VerificationOutcome> {
  if (headers.has(SIMULATION_SIGNATURE_HEADER)) {
    return verifySimulatedSignature(headers, rawBody);
  }
  return verifyPayPalSignature(headers, rawBody);
}

async function verifyPayPalSignature(
  headers: Headers,
  rawBody: string
): Promise<VerificationOutcome> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) {
    return { ok: false, reason: "PAYPAL_WEBHOOK_ID is not configured" };
  }

  const transmission = {
    auth_algo: headers.get("paypal-auth-algo"),
    cert_url: headers.get("paypal-cert-url"),
    transmission_id: headers.get("paypal-transmission-id"),
    transmission_sig: headers.get("paypal-transmission-sig"),
    transmission_time: headers.get("paypal-transmission-time"),
  };

  const missing = Object.entries(transmission)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Missing PayPal signature headers: ${missing.join(", ")}`,
    };
  }

  // splice in the raw body as-is, re-stringifying it can break the signature
  const body =
    JSON.stringify({ ...transmission, webhook_id: webhookId }).slice(0, -1) +
    `,"webhook_event":${rawBody}}`;

  try {
    const result = await paypalRequest<{ verification_status: string }>(
      "/v1/notifications/verify-webhook-signature",
      { method: "POST", body }
    );
    return result.verification_status === "SUCCESS"
      ? { ok: true, result: "VERIFIED" }
      : { ok: false, reason: `PayPal verification status: ${result.verification_status}` };
  } catch (error) {
    // fail closed, PayPal will retry the delivery anyway
    return {
      ok: false,
      reason: `PayPal verification call failed: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
}

function verifySimulatedSignature(
  headers: Headers,
  rawBody: string
): VerificationOutcome {
  const secret = process.env.PAYTRACE_SIMULATED_WEBHOOK_SECRET;

  if (process.env.NODE_ENV === "production") {
    return { ok: false, reason: "Simulated webhooks are disabled in production" };
  }
  if (!secret || secret.length < 32) {
    return {
      ok: false,
      reason: "PAYTRACE_SIMULATED_WEBHOOK_SECRET must be set (32+ chars)",
    };
  }

  const signature = headers.get(SIMULATION_SIGNATURE_HEADER) ?? "";
  const timestamp = headers.get(SIMULATION_TIMESTAMP_HEADER) ?? "";

  const sentAt = Date.parse(timestamp);
  if (Number.isNaN(sentAt) || Math.abs(Date.now() - sentAt) > SIMULATION_MAX_SKEW_MS) {
    return { ok: false, reason: "Simulation timestamp missing or outside allowed window" };
  }

  const expected = signSimulatedWebhook(secret, timestamp, rawBody);
  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "Invalid simulation signature" };
  }

  return { ok: true, result: "SIMULATED_VERIFIED" };
}

// hex HMAC-SHA256 of "<timestamp>.<rawBody>"
export function signSimulatedWebhook(
  secret: string,
  timestamp: string,
  rawBody: string
): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}
