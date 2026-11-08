import type {
  PaymentStatus,
  Transaction,
  WebhookEventRecord,
  WebhookVerificationResult,
} from "@/lib/domain/types";
import { isForwardTransition, statusFromEventType } from "@/lib/paypal/status";
import { toMoney, type PayPalWebhookEvent } from "@/lib/paypal/types";
import { withDb, type Database } from "@/lib/storage/store";
import { associateEvent } from "@/lib/webhooks/associate";

export interface ProcessResult {
  duplicate: boolean;
  event: WebhookEventRecord;
  transaction: Transaction | null;
}

// Saves a verified event and applies it. Repeats of an event we already handled
// just bump deliveryCount. FAILED events get processed again on retry.
export function processWebhookEvent(
  event: PayPalWebhookEvent,
  verification: WebhookVerificationResult
): Promise<ProcessResult> {
  return withDb((db) => {
    const now = new Date().toISOString();
    const existing = db.webhookEvents[event.id];

    if (existing && existing.processingStatus !== "FAILED") {
      existing.deliveryCount += 1;
      existing.lastReceivedAt = now;
      const transaction = existing.orderId ? db.transactions[existing.orderId] ?? null : null;
      return { duplicate: true, event: existing, transaction };
    }

    const record = buildEventRecord(db, event, verification, now);
    const transaction = record.orderId ? applyToTransaction(db, record, record.orderId, now) : null;

    db.webhookEvents[event.id] = record;
    return { duplicate: false, event: record, transaction };
  });
}

export function recordFailedWebhookEvent(
  event: PayPalWebhookEvent,
  verification: WebhookVerificationResult,
  error: unknown
): Promise<void> {
  return withDb((db) => {
    const record = buildEventRecord(db, event, verification, new Date().toISOString());
    record.processingStatus = "FAILED";
    record.processingError = error instanceof Error ? error.message : String(error);
    db.webhookEvents[event.id] = record;
  });
}

function buildEventRecord(
  db: Database,
  event: PayPalWebhookEvent,
  verification: WebhookVerificationResult,
  now: string
): WebhookEventRecord {
  const existing = db.webhookEvents[event.id];
  const association = associateEvent(event);
  // refund events only have the capture id, look up the order from that
  const orderId =
    association.orderId ??
    (association.captureId ? findOrderIdByCapture(db, association.captureId) : null);

  return {
    eventId: event.id,
    eventType: event.event_type,
    resourceType: event.resource_type ?? null,
    resourceId: event.resource?.id ?? null,
    orderId,
    captureId: association.captureId,
    refundId: association.refundId,
    amount: toMoney(event.resource?.amount),
    resourceStatus: event.resource?.status ?? null,
    verification,
    processingStatus: "IGNORED",
    processingError: null,
    deliveryCount: (existing?.deliveryCount ?? 0) + 1,
    eventCreatedAt: event.create_time ?? null,
    firstReceivedAt: existing?.firstReceivedAt ?? now,
    lastReceivedAt: now,
    payload: event,
  };
}

function applyToTransaction(
  db: Database,
  record: WebhookEventRecord,
  orderId: string,
  now: string
): Transaction | null {
  const current = db.transactions[orderId];
  let nextStatus = statusFromEventType(record.eventType);

  if (!nextStatus) {
    record.processingError = `No state transition defined for ${record.eventType}`;
    return current ?? null;
  }

  if (nextStatus === "REFUNDED" && current?.amount && record.amount) {
    nextStatus = isPartialRefund(current.amount.value, record.amount.value)
      ? "PARTIALLY_REFUNDED"
      : "REFUNDED";
  }

  // normally create-order already made the record, but webhooks can beat it
  const transaction: Transaction = current ?? {
    orderId,
    captureId: null,
    amount: null,
    localStatus: "CREATED",
    paypalStatus: null,
    lastReconciledAt: null,
    lastUpdatedBy: "webhook",
    createdAt: now,
    updatedAt: now,
  };

  transaction.captureId ??= record.captureId;
  // refund amount != order total, so don't take it from refund events
  if (!transaction.amount && record.resourceType !== "refund") {
    transaction.amount = record.amount;
  }

  // PayPal doesn't guarantee delivery order. An event must be at least as new as the
  // last one applied (resource update_time) and must not move the status backwards.
  const eventTime = (record.payload as PayPalWebhookEvent).resource?.update_time ?? record.eventCreatedAt;
  const lastApplied = transaction.lastEventUpdateTime ?? null;

  if (eventTime && lastApplied && Date.parse(eventTime) < Date.parse(lastApplied)) {
    record.processingError = `Stale event: resource updated ${eventTime}, a newer update (${lastApplied}) was already applied`;
  } else if (transaction.localStatus === nextStatus) {
    // e.g. the capture API already recorded COMPLETED; the webhook confirms it
    if (eventTime) transaction.lastEventUpdateTime = eventTime;
    record.processingStatus = "CONFIRMED";
    record.processingError = `Matches our record (${nextStatus})`;
  } else if (isForwardTransition(transaction.localStatus, nextStatus)) {
    transaction.localStatus = nextStatus;
    transaction.lastUpdatedBy = "webhook";
    transaction.updatedAt = now;
    if (eventTime) transaction.lastEventUpdateTime = eventTime;
    record.processingStatus = "PROCESSED";
  } else {
    record.processingError = staleReason(transaction.localStatus, nextStatus);
  }

  db.transactions[orderId] = transaction;
  return transaction;
}

function staleReason(current: PaymentStatus, proposed: PaymentStatus): string {
  return `Late event: order is already ${current}, so it isn't moved back to ${proposed}`;
}

function isPartialRefund(total: string, refunded: string): boolean {
  return Math.round(Number(refunded) * 100) < Math.round(Number(total) * 100);
}

function findOrderIdByCapture(db: Database, captureId: string): string | null {
  for (const tx of Object.values(db.transactions)) {
    if (tx.captureId === captureId) return tx.orderId;
  }
  for (const ev of Object.values(db.webhookEvents)) {
    if (ev.captureId === captureId && ev.orderId) return ev.orderId;
  }
  return null;
}
