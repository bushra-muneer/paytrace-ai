import { randomUUID } from "crypto";
import type {
  Incident,
  IncidentEvidence,
  IncidentSeverity,
  IncidentType,
  Money,
  PaymentStatus,
  Transaction,
} from "@/lib/domain/types";
import { paypalRequest } from "@/lib/paypal/client";
import {
  authoritativeStatus,
  FUNDS_CAPTURED,
  latestCapture,
  PRE_CAPTURE,
} from "@/lib/paypal/status";
import { toMoney, type PayPalOrder } from "@/lib/paypal/types";
import { proposeActionInDb } from "@/lib/recovery/propose";
import { readDb, withDb, type Database } from "@/lib/storage/store";

// Compares PayPal (fetched from the API, not from webhooks) with our local
// record. Opens incidents on mismatch and resolves them once things line up.

export interface ReconciliationResult {
  orderId: string;
  paypalStatus: PaymentStatus;
  localStatus: PaymentStatus | null;
  inSync: boolean;
  openIncidents: Incident[];
  resolvedIncidents: Incident[];
}

interface Finding {
  type: IncidentType;
  severity: IncidentSeverity;
  summary: string;
  financialImpact: Money | null;
  evidence: IncidentEvidence[];
}

export async function reconcileOrder(orderId: string): Promise<ReconciliationResult> {
  // fetch outside the lock so a slow PayPal call doesn't block other writes
  const order = await paypalRequest<PayPalOrder>(
    `/v2/checkout/orders/${encodeURIComponent(orderId)}`
  );
  const paypalStatus = authoritativeStatus(order);
  const observedAt = new Date().toISOString();

  return withDb((db) => {
    const transaction = db.transactions[orderId] ?? null;
    const findings = detect(order, paypalStatus, transaction, db, observedAt);
    const { open, resolved } = upsertIncidents(db, orderId, order, paypalStatus, transaction, findings, observedAt);

    if (transaction) {
      transaction.paypalStatus = paypalStatus;
      transaction.lastReconciledAt = observedAt;
      transaction.captureId ??= latestCapture(order)?.id ?? null;
    }

    return {
      orderId,
      paypalStatus,
      localStatus: transaction?.localStatus ?? null,
      inSync: open.length === 0,
      openIncidents: open,
      resolvedIncidents: resolved,
    };
  });
}

export async function reconcileAll(): Promise<{
  results: ReconciliationResult[];
  errors: { orderId: string; error: string }[];
}> {
  const db = await readDb();
  const results: ReconciliationResult[] = [];
  const errors: { orderId: string; error: string }[] = [];

  for (const orderId of Object.keys(db.transactions)) {
    try {
      results.push(await reconcileOrder(orderId));
    } catch (error) {
      errors.push({
        orderId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
  return { results, errors };
}

function detect(
  order: PayPalOrder,
  paypalStatus: PaymentStatus,
  transaction: Transaction | null,
  db: Database,
  observedAt: string
): Finding[] {
  const capture = latestCapture(order);
  const paypalAmount = toMoney(capture?.amount ?? order.purchase_units?.[0]?.amount);
  const paypalEvidence: IncidentEvidence = {
    source: "paypal_api",
    reference: order.id,
    observedAt,
    detail: `PayPal order ${order.status}${capture ? `, capture ${capture.id} ${capture.status}` : ""}`,
    data: { orderStatus: order.status, capture },
  };
  const webhookEvidence = relatedWebhookEvidence(db, order.id);

  if (!transaction) {
    return [
      {
        type: "MISSING_LOCAL_RECORD",
        severity: FUNDS_CAPTURED.has(paypalStatus) ? "HIGH" : "MEDIUM",
        summary: `PayPal has order ${order.id} (${paypalStatus}) but there is no local record`,
        financialImpact: FUNDS_CAPTURED.has(paypalStatus) ? paypalAmount : null,
        evidence: [paypalEvidence, ...webhookEvidence],
      },
    ];
  }

  const findings: Finding[] = [];
  const localEvidence: IncidentEvidence = {
    source: "local_db",
    reference: transaction.orderId,
    observedAt,
    detail: `Local status ${transaction.localStatus}, last updated by ${transaction.lastUpdatedBy} at ${transaction.updatedAt.slice(0, 16).replace("T", " ")} UTC`,
    data: transaction,
  };
  const evidence = [paypalEvidence, localEvidence, ...webhookEvidence];

  if (transaction.localStatus !== paypalStatus) {
    findings.push({
      type: "STATE_MISMATCH",
      severity: mismatchSeverity(paypalStatus, transaction.localStatus),
      summary: `PayPal = ${paypalStatus}, Local = ${transaction.localStatus}`,
      financialImpact: paypalAmount ?? transaction.amount,
      evidence,
    });
  }

  if (
    transaction.amount &&
    paypalAmount &&
    (transaction.amount.currency !== paypalAmount.currency ||
      Number(transaction.amount.value) !== Number(paypalAmount.value))
  ) {
    findings.push({
      type: "AMOUNT_MISMATCH",
      severity: "HIGH",
      summary: `PayPal amount ${paypalAmount.currency} ${paypalAmount.value} differs from local ${transaction.amount.currency} ${transaction.amount.value}`,
      financialImpact: paypalAmount,
      evidence,
    });
  }

  return findings;
}

function mismatchSeverity(paypal: PaymentStatus, local: PaymentStatus): IncidentSeverity {
  // we think we're paid but PayPal doesn't hold the money: stop fulfilment
  if (FUNDS_CAPTURED.has(local) && !FUNDS_CAPTURED.has(paypal)) return "CRITICAL";
  // customer was charged but we never marked the order paid
  if (FUNDS_CAPTURED.has(paypal) && PRE_CAPTURE.has(local)) return "HIGH";
  return "MEDIUM";
}

function relatedWebhookEvidence(db: Database, orderId: string): IncidentEvidence[] {
  return Object.values(db.webhookEvents)
    .filter((e) => e.orderId === orderId)
    .sort((a, b) => a.firstReceivedAt.localeCompare(b.firstReceivedAt))
    .map((e) => ({
      source: "webhook" as const,
      reference: e.eventId,
      observedAt: e.lastReceivedAt,
      detail: `${e.eventType} -> ${e.processingStatus}${e.deliveryCount > 1 ? ` (delivered ${e.deliveryCount}x)` : ""}${e.processingError ? `: ${e.processingError}` : ""}`,
    }));
}

function upsertIncidents(
  db: Database,
  orderId: string,
  order: PayPalOrder,
  paypalStatus: PaymentStatus,
  transaction: Transaction | null,
  findings: Finding[],
  now: string
): { open: Incident[]; resolved: Incident[] } {
  const open: Incident[] = [];
  const activeFingerprints = new Set<string>();

  for (const finding of findings) {
    const fingerprint = `${finding.type}:${orderId}`;
    activeFingerprints.add(fingerprint);

    const existing = Object.values(db.incidents).find(
      (i) => i.fingerprint === fingerprint && i.status === "OPEN"
    );

    const incident: Incident = {
      id: existing?.id ?? `inc_${randomUUID()}`,
      fingerprint,
      type: finding.type,
      severity: finding.severity,
      status: "OPEN",
      orderId,
      captureId: latestCapture(order)?.id ?? transaction?.captureId ?? null,
      paypalStatus,
      localStatus: transaction?.localStatus ?? null,
      summary: finding.summary,
      financialImpact: finding.financialImpact,
      evidence: finding.evidence,
      aiAnalysis: existing?.aiAnalysis ?? null,
      detectedAt: existing?.detectedAt ?? now,
      lastSeenAt: now,
      resolvedAt: null,
    };
    db.incidents[incident.id] = incident;
    open.push(incident);

    if (!existing) proposeDefaultAction(db, incident);
  }

  const resolved: Incident[] = [];
  for (const incident of Object.values(db.incidents)) {
    if (
      incident.orderId === orderId &&
      incident.status === "OPEN" &&
      !activeFingerprints.has(incident.fingerprint)
    ) {
      incident.status = "RESOLVED";
      incident.resolvedAt = now;
      incident.lastSeenAt = now;
      resolved.push(incident);
      withdrawOpenProposals(db, incident.id, now);
    }
  }

  return { open, resolved };
}

// Auto-propose the obvious fix. Never refunds, those need the AI or a person.
function proposeDefaultAction(db: Database, incident: Incident): void {
  if (incident.type === "STATE_MISMATCH") {
    proposeActionInDb(db, {
      incidentId: incident.id,
      type: "SYNC_LOCAL_STATUS",
      proposedBy: "system",
      rationale: `Align local status ${incident.localStatus} with PayPal's authoritative ${incident.paypalStatus}`,
    });
  } else if (incident.type === "MISSING_LOCAL_RECORD") {
    proposeActionInDb(db, {
      incidentId: incident.id,
      type: "CREATE_LOCAL_RECORD",
      proposedBy: "system",
      rationale: "Create the missing local record from PayPal's order data",
    });
  }
}

function withdrawOpenProposals(db: Database, incidentId: string, now: string): void {
  for (const action of Object.values(db.recoveryActions)) {
    if (action.incidentId === incidentId && action.status === "PROPOSED") {
      action.status = "REJECTED";
      action.decidedBy = "system";
      action.decidedAt = now;
      action.decisionNote = "Incident resolved before approval";
      action.audit.push({ at: now, actor: "system", event: "REJECTED", detail: action.decisionNote });
    }
  }
}
