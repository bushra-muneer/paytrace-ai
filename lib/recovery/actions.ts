import type {
  PaymentStatus,
  RecoveryAction,
  RecoveryActionStatus,
  RefundOperation,
  Transaction,
} from "@/lib/domain/types";
import { PayPalApiError, paypalIssues, paypalRequest } from "@/lib/paypal/client";
import { authoritativeStatus, latestCapture } from "@/lib/paypal/status";
import { toMoney, type PayPalOrder, type PayPalRefund } from "@/lib/paypal/types";
import { reconcileOrder } from "@/lib/reconciliation/reconcile";
import {
  findUnresolvedRefund,
  isAutomatedActor,
  newRefundOperation,
  proposeActionInDb,
  RecoveryActionError,
  type ProposeInput,
} from "@/lib/recovery/propose";
import { withDb, type Database } from "@/lib/storage/store";

// Flow: PROPOSED -> APPROVED -> EXECUTING -> EXECUTED | FAILED | UNCERTAIN (or PROPOSED -> REJECTED).
// UNCERTAIN -> EXECUTING again is a retry of the same refund with the same PayPal-Request-Id.
// Someone other than the proposer has to approve before anything runs.

// live PayPal state doesn't allow the action, or PayPal definitively rejected it: nothing changed
class PreconditionFailed extends Error {}

// a refund request was sent and we don't know if PayPal processed it
class OutcomeUnknown extends Error {}

const REFUND_TIMEOUT_MS = 20_000;

export function proposeAction(input: ProposeInput): Promise<RecoveryAction> {
  return withDb((db) => proposeActionInDb(db, input));
}

export interface DecisionInput {
  actor: string;
  note?: string;
  acknowledgeFinancialImpact?: boolean; // required for refunds
}

export function approveAction(id: string, input: DecisionInput): Promise<RecoveryAction> {
  return withDb((db) => {
    const action = transition(db, id, "PROPOSED", "APPROVED", input.actor, input.note);
    if (action.proposedBy === input.actor) {
      throw new RecoveryActionError("You can't approve your own proposal", 403);
    }
    if (action.financial && !input.acknowledgeFinancialImpact) {
      throw new RecoveryActionError("Refunds need acknowledgeFinancialImpact: true", 400);
    }
    action.decidedBy = input.actor;
    action.decidedAt = action.audit.at(-1)!.at;
    action.decisionNote = input.note ?? null;

    if (action.type === "REFUND_CAPTURE") {
      // fixed now, before any request, and reused on every retry of this refund
      action.refundOperation = newRefundOperation(action.id);
      audit(action, input.actor, "REQUEST_ID_ASSIGNED", describeOperation(action.refundOperation));
    }
    return action;
  });
}

export function rejectAction(id: string, input: DecisionInput): Promise<RecoveryAction> {
  return withDb((db) => {
    const action = transition(db, id, "PROPOSED", "REJECTED", input.actor, input.note);
    action.decidedBy = input.actor;
    action.decidedAt = action.audit.at(-1)!.at;
    action.decisionNote = input.note ?? null;
    return action;
  });
}

export async function executeAction(id: string, actor: string): Promise<RecoveryAction> {
  // claim inside the lock so a double click (or two tabs) can't run it twice
  const action = await withDb((db) => {
    const retrying = db.recoveryActions[id]?.status === "UNCERTAIN";
    const claimed = transition(
      db,
      id,
      retrying ? "UNCERTAIN" : "APPROVED",
      "EXECUTING",
      actor,
      retrying ? "Retry of the same refund, same PayPal-Request-Id" : undefined
    );
    if (claimed.type === "REFUND_CAPTURE") {
      const other = findUnresolvedRefund(db, claimed.orderId, claimed.id);
      if (other) {
        throw new RecoveryActionError(`Order has another unresolved refund (${other.id}, ${other.status})`, 409);
      }
      claimed.refundOperation ??= newRefundOperation(claimed.id); // approved before request ids were stored
    }
    return structuredClone(claimed);
  });

  let outcome: Awaited<ReturnType<typeof runAction>>;
  try {
    outcome = await runAction(action, actor);
  } catch (error) {
    // Once a refund request has been sent, only a confirmed refund ends the operation.
    // Anything else on a retry (lookup failed, "already refunded"...) keeps it UNCERTAIN,
    // because the earlier attempt may be the reason.
    const sentBefore = (action.refundOperation?.attempts ?? 0) > 0;
    const unknown = error instanceof OutcomeUnknown || sentBefore;
    const reason = error instanceof Error ? error.message : String(error);
    const message = sentBefore && !(error instanceof OutcomeUnknown) ? `Earlier attempt still unconfirmed. ${reason}` : reason;
    const finished = await withDb((db) => {
      const failed = transition(db, id, "EXECUTING", unknown ? "UNCERTAIN" : "FAILED", actor, message);
      failed.error = message;
      failed.result = { moneyMoved: unknown ? "unknown" : false };
      return failed;
    });
    if (unknown) {
      await reconcileOrder(action.orderId).catch((e) => console.error(`Reconcile after uncertain refund failed:`, e));
    }
    return finished;
  }

  const executed = await withDb((db) => {
    const done = transition(db, id, "EXECUTING", "EXECUTED", actor, outcome.detail);
    done.executedAt = done.audit.at(-1)!.at;
    done.result = outcome.result;
    done.error = null;
    if (done.refundOperation && outcome.refund) {
      done.refundOperation.refundId = outcome.refund.id;
      done.refundOperation.refundStatus = outcome.refund.status;
    }
    return done;
  });

  // re-run reconcile so the incident closes if the fix worked
  await reconcileOrder(action.orderId).catch((error) =>
    console.error(`Post-recovery reconcile failed for ${action.orderId}:`, error)
  );
  return executed;
}

function transition(
  db: Database,
  id: string,
  from: RecoveryActionStatus,
  to: RecoveryActionStatus,
  actor: string,
  detail?: string
): RecoveryAction {
  if (!actor?.trim()) throw new RecoveryActionError("actor is required", 400);
  if (isAutomatedActor(actor)) {
    throw new RecoveryActionError(`"${actor}" can only propose actions, a person has to decide`, 403);
  }
  const action = db.recoveryActions[id];
  if (!action) throw new RecoveryActionError("Recovery action not found", 404);
  if (action.status !== from) {
    throw new RecoveryActionError(`Action is ${action.status}, expected ${from}`, 409);
  }
  action.status = to;
  audit(action, actor, to, detail ?? null);
  return action;
}

function audit(action: RecoveryAction, actor: string, event: string, detail: string | null) {
  action.audit.push({ at: new Date().toISOString(), actor, event, detail });
}

interface RunOutcome {
  paypalStatus: PaymentStatus;
  result: unknown;
  detail: string;
  refund?: PayPalRefund;
}

async function runAction(action: RecoveryAction, actor: string): Promise<RunOutcome> {
  // state may have changed since approval, so fetch it again
  const order = await getOrder(action.orderId);
  const paypalStatus = authoritativeStatus(order);
  const checked = `PayPal re-checked before running: ${paypalStatus}`;

  switch (action.type) {
    case "SYNC_LOCAL_STATUS":
      return { paypalStatus, detail: checked, result: await syncLocalStatus(action, order, paypalStatus) };
    case "CREATE_LOCAL_RECORD":
      return { paypalStatus, detail: checked, result: await createLocalRecord(order, paypalStatus) };
    case "REFUND_CAPTURE": {
      const { refund, alreadyExisted } = await refundCapture(action, order, actor);
      const detail = alreadyExisted
        ? `${checked}. Refund ${refund.id} (${refund.status}) already existed at PayPal, no new request sent`
        : `${checked}. Refund ${refund.id} ${refund.status}`;
      return { paypalStatus, detail, refund, result: { refundId: refund.id, refundStatus: refund.status, alreadyExisted } };
    }
  }
}

function getOrder(orderId: string) {
  return paypalRequest<PayPalOrder>(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
}

function syncLocalStatus(action: RecoveryAction, order: PayPalOrder, paypalStatus: PaymentStatus) {
  if (action.params.targetStatus && action.params.targetStatus !== paypalStatus) {
    throw new PreconditionFailed(
      `PayPal status changed since approval (${action.params.targetStatus} -> ${paypalStatus}), propose a new action`
    );
  }
  return withDb((db) => {
    const tx = db.transactions[order.id];
    if (!tx) throw new PreconditionFailed("No local record to update, use CREATE_LOCAL_RECORD");
    const previous = tx.localStatus;
    tx.localStatus = paypalStatus;
    tx.captureId ??= latestCapture(order)?.id ?? null;
    tx.lastUpdatedBy = "manual";
    tx.updatedAt = new Date().toISOString();
    return { previousStatus: previous, newStatus: paypalStatus };
  });
}

function createLocalRecord(order: PayPalOrder, paypalStatus: PaymentStatus) {
  return withDb((db) => {
    if (db.transactions[order.id]) throw new PreconditionFailed("Local record already exists");
    const now = new Date().toISOString();
    const capture = latestCapture(order);
    const tx: Transaction = {
      orderId: order.id,
      captureId: capture?.id ?? null,
      amount: toMoney(capture?.amount ?? order.purchase_units?.[0]?.amount),
      localStatus: paypalStatus,
      paypalStatus,
      lastReconciledAt: null,
      lastUpdatedBy: "manual",
      createdAt: now,
      updatedAt: now,
    };
    db.transactions[order.id] = tx;
    return { created: tx };
  });
}

async function refundCapture(
  action: RecoveryAction,
  order: PayPalOrder,
  actor: string
): Promise<{ refund: PayPalRefund; alreadyExisted: boolean }> {
  const op = action.refundOperation!;

  // 1. Did this exact refund already happen (e.g. an earlier attempt timed out after PayPal processed it)?
  const existing = await findRefund(order, op);
  if (existing) return { refund: existing, alreadyExisted: true };

  // 2. Is a refund still possible, and for this amount?
  const capture = latestCapture(order);
  if (!capture) throw new PreconditionFailed("Order has no capture to refund");
  if (capture.status !== "COMPLETED" && capture.status !== "PARTIALLY_REFUNDED") {
    throw new PreconditionFailed(`Capture ${capture.id} is ${capture.status}, can't refund`);
  }
  const remaining = refundableAmount(order, capture.amount);
  const amount = action.params.amount;
  if (amount) {
    if (amount.currency !== capture.amount.currency_code) {
      throw new PreconditionFailed(`Refund currency ${amount.currency} does not match capture ${capture.amount.currency_code}`);
    }
    if (Number(amount.value) <= 0 || Number(amount.value) > remaining) {
      throw new PreconditionFailed(`Refund amount ${amount.value} must be between 0 and the ${remaining.toFixed(2)} still refundable`);
    }
  } else if (remaining <= 0) {
    throw new PreconditionFailed(`Capture ${capture.id} has nothing left to refund`);
  }

  // 3. Record the attempt before sending, so a crash mid-request still leaves a trace.
  await withDb((db) => {
    const stored = db.recoveryActions[action.id];
    stored.refundOperation!.attempts += 1;
    stored.refundOperation!.lastAttemptAt = new Date().toISOString();
    audit(stored, actor, "REFUND_REQUESTED", `Attempt ${stored.refundOperation!.attempts}. ${describeOperation(op)}`);
  });

  // 4. Send with the stored request id. A repeat with the same id returns the original result.
  try {
    const refund = await paypalRequest<PayPalRefund>(`/v2/payments/captures/${encodeURIComponent(capture.id)}/refund`, {
      method: "POST",
      headers: { "PayPal-Request-Id": op.requestId, Prefer: "return=representation" },
      body: JSON.stringify({
        ...(amount ? { amount: { currency_code: amount.currency, value: amount.value } } : {}),
        invoice_id: op.invoiceId,
      }),
      timeoutMs: REFUND_TIMEOUT_MS,
    });
    return { refund, alreadyExisted: false };
  } catch (error) {
    if (error instanceof PayPalApiError) {
      const issues = paypalIssues(error);
      if (error.status === 409 || issues.includes("PREVIOUS_REQUEST_IN_PROGRESS")) {
        throw new OutcomeUnknown(
          "PayPal is still processing an earlier request with this PayPal-Request-Id. Retry later; the same id is reused."
        );
      }
      if (issues.includes("DUPLICATE_INVOICE_ID")) {
        const found = await findRefund(await getOrder(action.orderId), op);
        if (found) return { refund: found, alreadyExisted: true };
        throw new OutcomeUnknown("PayPal says this refund's invoice_id was already used, but the refund isn't visible yet. Retry later.");
      }
      if (error.status < 500) {
        // 400/422 and similar: PayPal refused the request, so no refund was created
        throw new PreconditionFailed(`PayPal rejected the refund: ${issues.join(", ") || error.status}`);
      }
    }

    // 5xx, timeout or network error: PayPal may or may not have processed it. Look once more.
    const found = await getOrder(action.orderId).then((o) => findRefund(o, op)).catch(() => null);
    if (found) return { refund: found, alreadyExisted: true };
    throw new OutcomeUnknown(
      `No definite answer from PayPal (${error instanceof Error ? error.message : String(error)}). Retry resends with the same PayPal-Request-Id.`
    );
  }
}

// Finds this operation's refund at PayPal by stored refund id or by our invoice_id.
async function findRefund(order: PayPalOrder, op: RefundOperation): Promise<PayPalRefund | null> {
  const refunds = order.purchase_units?.flatMap((u) => u.payments?.refunds ?? []) ?? [];
  const direct = refunds.find((r) => (op.refundId && r.id === op.refundId) || r.invoice_id === op.invoiceId);
  if (direct) return direct;

  // the order view may leave out invoice_id, the refund itself always has it
  for (const r of refunds.filter((r) => r.invoice_id === undefined)) {
    const full = await paypalRequest<PayPalRefund>(`/v2/payments/refunds/${encodeURIComponent(r.id)}`);
    if (full.invoice_id === op.invoiceId) return full;
  }
  return null;
}

function refundableAmount(order: PayPalOrder, captured: { currency_code: string; value: string }): number {
  const refunded = (order.purchase_units ?? [])
    .flatMap((u) => u.payments?.refunds ?? [])
    .filter((r) => r.status !== "CANCELLED" && r.status !== "FAILED" && r.amount?.currency_code === captured.currency_code)
    .reduce((sum, r) => sum + Number(r.amount!.value), 0);
  return Math.round((Number(captured.value) - refunded) * 100) / 100;
}

function describeOperation(op: RefundOperation): string {
  return `PayPal-Request-Id ${op.requestId}, invoice_id ${op.invoiceId}`;
}
