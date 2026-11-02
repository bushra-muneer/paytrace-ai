import type {
  PaymentStatus,
  RecoveryAction,
  RecoveryActionStatus,
  Transaction,
} from "@/lib/domain/types";
import { PayPalApiError, paypalRequest } from "@/lib/paypal/client";
import { authoritativeStatus, latestCapture } from "@/lib/paypal/status";
import { toMoney, type PayPalOrder } from "@/lib/paypal/types";
import { reconcileOrder } from "@/lib/reconciliation/reconcile";
import {
  findOtherRefund,
  isAutomatedActor,
  proposeActionInDb,
  RecoveryActionError,
  type ProposeInput,
} from "@/lib/recovery/propose";
import { withDb, type Database } from "@/lib/storage/store";

// Flow: PROPOSED -> APPROVED -> EXECUTING -> EXECUTED/FAILED (or PROPOSED -> REJECTED).
// Someone other than the proposer has to approve before anything runs.

// thrown when live PayPal state doesn't allow the action, before anything is changed
class PreconditionFailed extends Error {}

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
      throw new RecoveryActionError(
        "Refunds need acknowledgeFinancialImpact: true",
        400
      );
    }
    action.decidedBy = input.actor;
    action.decidedAt = action.audit.at(-1)!.at;
    action.decisionNote = input.note ?? null;
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
  // flip to EXECUTING inside the lock so a double click can't run it twice
  const action = await withDb((db) => {
    const claimed = transition(db, id, "APPROVED", "EXECUTING", actor);
    if (claimed.type === "REFUND_CAPTURE") {
      const other = findOtherRefund(db, claimed.orderId, claimed.id);
      if (other) {
        throw new RecoveryActionError(`Order already has a refund action (${other.id}, ${other.status})`, 409);
      }
    }
    return structuredClone(claimed);
  });

  let outcome: Awaited<ReturnType<typeof runAction>>;
  try {
    outcome = await runAction(action);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // a precheck failure or a 4xx from PayPal means nothing happened; a timeout or 5xx might have
    const moneyMoved =
      error instanceof PreconditionFailed || (error instanceof PayPalApiError && error.status < 500)
        ? false
        : "unknown";
    return withDb((db) => {
      const failed = transition(db, id, "EXECUTING", "FAILED", actor, message);
      failed.error = message;
      failed.result = { moneyMoved };
      return failed;
    });
  }

  const executed = await withDb((db) => {
    const done = transition(db, id, "EXECUTING", "EXECUTED", actor, `PayPal re-checked before running: ${outcome.paypalStatus}`);
    done.executedAt = done.audit.at(-1)!.at;
    done.result = outcome.result;
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
  action.audit.push({ at: new Date().toISOString(), actor, event: to, detail: detail ?? null });
  return action;
}

async function runAction(action: RecoveryAction): Promise<{ paypalStatus: PaymentStatus; result: unknown }> {
  // state may have changed since approval, so fetch it again
  const order = await paypalRequest<PayPalOrder>(
    `/v2/checkout/orders/${encodeURIComponent(action.orderId)}`
  );
  const paypalStatus = authoritativeStatus(order);

  switch (action.type) {
    case "SYNC_LOCAL_STATUS":
      return { paypalStatus, result: await syncLocalStatus(action, order, paypalStatus) };
    case "CREATE_LOCAL_RECORD":
      return { paypalStatus, result: await createLocalRecord(order, paypalStatus) };
    case "REFUND_CAPTURE":
      return { paypalStatus, result: await refundCapture(action, order) };
  }
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

async function refundCapture(action: RecoveryAction, order: PayPalOrder) {
  const capture = latestCapture(order);
  if (!capture) throw new PreconditionFailed("Order has no capture to refund");
  if (capture.status !== "COMPLETED" && capture.status !== "PARTIALLY_REFUNDED") {
    throw new PreconditionFailed(`Capture ${capture.id} is ${capture.status}, can't refund`);
  }

  const amount = action.params.amount;
  if (amount) {
    if (amount.currency !== capture.amount.currency_code) {
      throw new PreconditionFailed(`Refund currency ${amount.currency} does not match capture ${capture.amount.currency_code}`);
    }
    if (Number(amount.value) <= 0 || Number(amount.value) > Number(capture.amount.value)) {
      throw new PreconditionFailed(`Refund amount ${amount.value} must be between 0 and ${capture.amount.value}`);
    }
  }

  // action id as PayPal-Request-Id so a retry can't refund twice
  return paypalRequest<{ id: string; status: string }>(
    `/v2/payments/captures/${encodeURIComponent(capture.id)}/refund`,
    {
      method: "POST",
      headers: { "PayPal-Request-Id": action.id, Prefer: "return=representation" },
      body: JSON.stringify(
        amount ? { amount: { currency_code: amount.currency, value: amount.value } } : {}
      ),
    }
  );
}
