#!/usr/bin/env node
// Send a fake signed webhook to the local server.
//
// node --env-file=.env.local scripts/simulate-webhook.mjs <EVENT_TYPE> <ORDER_ID>
//   [--capture-id X] [--event-id X] [--amount 10.00] [--currency EUR]
//   [--bad-signature] [--url http://localhost:3000/api/paypal/webhook]
//
// Use the same --event-id twice to test duplicate handling.
// Signing has to match lib/paypal/webhook-verification.ts.
import { createHmac, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "capture-id": { type: "string" },
    "event-id": { type: "string" },
    amount: { type: "string", default: "10.00" },
    currency: { type: "string", default: "EUR" },
    "bad-signature": { type: "boolean", default: false },
    url: { type: "string", default: "http://localhost:3000/api/paypal/webhook" },
  },
});

const [eventType, orderId] = positionals;
if (!eventType || !orderId) {
  console.error("Usage: simulate-webhook.mjs <EVENT_TYPE> <ORDER_ID> [options]");
  process.exit(1);
}

const secret = process.env.PAYTRACE_SIMULATED_WEBHOOK_SECRET;
if (!secret) {
  console.error("PAYTRACE_SIMULATED_WEBHOOK_SECRET is not set (use --env-file=.env.local)");
  process.exit(1);
}

const captureId = values["capture-id"] ?? `SIMCAP-${orderId}`;
const amount = { currency_code: values.currency, value: values.amount };
const api = "https://api.sandbox.paypal.com";

function buildResource() {
  if (eventType.startsWith("CHECKOUT.ORDER.")) {
    return {
      resource_type: "checkout-order",
      resource: {
        id: orderId,
        status: eventType.split(".").at(-1),
        purchase_units: [{ amount }],
        links: [{ href: `${api}/v2/checkout/orders/${orderId}`, rel: "self", method: "GET" }],
      },
    };
  }
  if (eventType === "PAYMENT.CAPTURE.REFUNDED") {
    return {
      resource_type: "refund",
      resource: {
        id: `SIMREF-${randomUUID().slice(0, 8)}`,
        status: "COMPLETED",
        amount,
        links: [{ href: `${api}/v2/payments/captures/${captureId}`, rel: "up", method: "GET" }],
      },
    };
  }
  return {
    resource_type: "capture",
    resource: {
      id: captureId,
      status: eventType.split(".").at(-1),
      amount,
      supplementary_data: { related_ids: { order_id: orderId } },
      links: [{ href: `${api}/v2/checkout/orders/${orderId}`, rel: "up", method: "GET" }],
    },
  };
}

const event = {
  id: values["event-id"] ?? `WH-SIM-${randomUUID()}`,
  event_version: "1.0",
  create_time: new Date().toISOString(),
  event_type: eventType,
  summary: `Simulated ${eventType}`,
  ...buildResource(),
};

const rawBody = JSON.stringify(event);
const timestamp = new Date().toISOString();
const signature = values["bad-signature"]
  ? "00".repeat(32)
  : createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");

const response = await fetch(values.url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-paytrace-simulation-signature": signature,
    "x-paytrace-simulation-timestamp": timestamp,
  },
  body: rawBody,
});

console.log(`sent ${eventType} ${event.id}`);
console.log(`got ${response.status}`, JSON.stringify(await response.json(), null, 2));
