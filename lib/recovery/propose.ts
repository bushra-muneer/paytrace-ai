import { randomUUID } from "crypto";
import type { RecoveryAction, RecoveryActionStatus, RecoveryActionType, RefundOperation } from "@/lib/domain/types";
import type { Database } from "@/lib/storage/store";

export class RecoveryActionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "RecoveryActionError";
  }
}

const FINANCIAL_TYPES: ReadonlySet<RecoveryActionType> = new Set(["REFUND_CAPTURE"]);

export interface ProposeInput {
  incidentId: string;
  type: RecoveryActionType;
  rationale: string;
  proposedBy: string;
  params?: RecoveryAction["params"];
}

// Call this inside withDb. Returns the existing proposal if there's already
// an open one of the same type for this incident.
export function proposeActionInDb(db: Database, input: ProposeInput): RecoveryAction {
  const incident = db.incidents[input.incidentId];
  if (!incident) throw new RecoveryActionError("Incident not found", 404);

  const duplicate = Object.values(db.recoveryActions).find(
    (a) =>
      a.incidentId === input.incidentId &&
      a.type === input.type &&
      (a.status === "PROPOSED" || a.status === "APPROVED")
  );
  if (duplicate) return duplicate;

  if (input.type === "REFUND_CAPTURE") {
    const unresolved = findUnresolvedRefund(db, incident.orderId);
    if (unresolved) {
      throw new RecoveryActionError(
        `Order already has an unresolved refund (${unresolved.id}, ${unresolved.status})`,
        409
      );
    }
    // a follow-up refund after one went through is a human decision, never an automated one
    const done = Object.values(db.recoveryActions).find(
      (a) => a.type === "REFUND_CAPTURE" && a.orderId === incident.orderId && a.status === "EXECUTED"
    );
    if (done && isAutomatedActor(input.proposedBy)) {
      throw new RecoveryActionError(`Order was already refunded by ${done.id}; only a person can propose another refund`, 409);
    }
  }

  const now = new Date().toISOString();
  const action: RecoveryAction = {
    id: `act_${randomUUID()}`,
    incidentId: incident.id,
    orderId: incident.orderId,
    captureId: incident.captureId,
    type: input.type,
    status: "PROPOSED",
    financial: FINANCIAL_TYPES.has(input.type),
    params: {
      ...(input.type === "SYNC_LOCAL_STATUS" && incident.paypalStatus
        ? { targetStatus: incident.paypalStatus }
        : {}),
      ...input.params,
    },
    rationale: input.rationale,
    proposedBy: input.proposedBy,
    proposedAt: now,
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    executedAt: null,
    result: null,
    error: null,
    audit: [{ at: now, actor: input.proposedBy, event: "PROPOSED", detail: input.rationale }],
  };
  db.recoveryActions[action.id] = action;
  return action;
}

const UNRESOLVED: ReadonlySet<RecoveryActionStatus> = new Set(["PROPOSED", "APPROVED", "EXECUTING", "UNCERTAIN"]);

// A refund on this order that hasn't reached a final outcome. While one exists, no other
// refund for the order can be proposed or run, so two refunds never race and an UNCERTAIN
// one gets resolved first (by retrying with its own request id). Older FAILED records
// without a definite "no money moved" are treated as unresolved too.
export function findUnresolvedRefund(db: Database, orderId: string, exceptId?: string) {
  return Object.values(db.recoveryActions).find(
    (a) =>
      a.type === "REFUND_CAPTURE" &&
      a.orderId === orderId &&
      a.id !== exceptId &&
      (UNRESOLVED.has(a.status) ||
        (a.status === "FAILED" && (a.result as { moneyMoved?: unknown } | null)?.moneyMoved !== false))
  );
}

// Called once, when a refund is approved. The same ids go on the first request and every retry.
export function newRefundOperation(actionId: string): RefundOperation {
  return {
    requestId: randomUUID(),
    invoiceId: `paytrace-${actionId}`,
    attempts: 0,
    lastAttemptAt: null,
    refundId: null,
    refundStatus: null,
  };
}

// "system" and "ai:<model>" can propose but never approve or execute.
export function isAutomatedActor(actor: string): boolean {
  return actor === "system" || actor.startsWith("ai:");
}
