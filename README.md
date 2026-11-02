# PayTrace AI

PayTrace AI is an AI-powered payment observability and recovery platform built for merchants and payment operations teams.

It reconstructs payment lifecycles, detects mismatches between PayPal and merchant application state, explains likely root causes, and recommends safe recovery actions.

## Key Capabilities

- Payment lifecycle reconstruction
- PayPal vs local state reconciliation
- Duplicate operation detection
- Refund safety checks
- Webhook event analysis
- AI-assisted incident investigation
- Human approval for sensitive financial actions
- Audit trail for recovery actions
- Transaction and incident analysis with AG Grid

## Tech Stack

- Next.js
- TypeScript
- PayPal Sandbox
- PayPal REST APIs: Orders v2 (create, get, capture), Payments v2 (refunds), Webhooks (signature verification)
- AG Grid
- Claude API (Anthropic) for the AI incident investigator
- JSON file store for the MVP (PostgreSQL planned)
- Tailwind CSS

## Getting Started

Install dependencies:

```bash
npm install
```

Copy `.env.example` to `.env.local` and fill in the PayPal Sandbox credentials. Set `ANTHROPIC_API_KEY` to enable AI investigations. Then:

```bash
npm run dev
```

Open http://localhost:3000. It redirects to the dashboard at `/dashboard`.

## How it works

1. **Payments:** `POST /api/paypal/create-order` creates a PayPal order and a local `CREATED` record. After the buyer approves, `POST /api/paypal/capture-order` captures it and updates the local record.
2. **Webhooks:** `POST /api/paypal/webhook` verifies every event's signature, skips duplicate event IDs, links the event to its order or capture, and applies forward-only state changes.
3. **Reconciliation:** `POST /api/reconcile` compares PayPal's state (read from the API) with local state. It opens incidents (`STATE_MISMATCH`, `AMOUNT_MISMATCH`, `MISSING_LOCAL_RECORD`) and proposes a safe fix.
4. **AI investigation:** `POST /api/incidents/:id/investigate` sends the incident and its evidence to Claude. Claude returns the root cause, an explanation, the financial impact and recommended actions.
5. **Recovery with human approval:** each recommended action starts as `PROPOSED`. A person other than the proposer must approve it, and refunds need an explicit acknowledgement that money moves. Execution re-checks PayPal first, and every step is recorded in an audit trail.

## Testing webhooks

**Simulated (local, no PayPal):** the simulator signs events with `PAYTRACE_SIMULATED_WEBHOOK_SECRET`. This path is disabled when `NODE_ENV=production`.

```bash
node --env-file=.env.local scripts/simulate-webhook.mjs PAYMENT.CAPTURE.COMPLETED <ORDER_ID>
```

**Real PayPal webhooks:**
1. Expose the app with a tunnel, e.g. `ngrok http 3000`.
2. Register `https://<tunnel>/api/paypal/webhook` on your PayPal app.
3. Put the Webhook ID in `PAYPAL_WEBHOOK_ID`.

Events from the dashboard's Webhooks Simulator cannot be verified by PayPal; use real sandbox payments.

**Reproducing an incident:** mark a captured order as pending locally, then reconcile it.

```bash
curl -X POST localhost:3000/api/dev/transactions -H "Content-Type: application/json" -d '{"orderId":"<ID>","localStatus":"PENDING"}'
curl -X POST localhost:3000/api/reconcile -H "Content-Type: application/json" -d '{"orderId":"<ID>"}'
```

## Known limitations (MVP)

- Storage is one JSON file, which needs a single server instance on persistent disk. It won't work on serverless hosts.
- There is no authentication: the "Acting as" name is self-declared. Add real auth before using approvals beyond a demo.