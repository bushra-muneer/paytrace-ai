import { randomUUID } from "crypto";
import type { RecoveryAction, RecoveryActionType } from "@/lib/domain/types";
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
    const existing = findOtherRefund(db, incident.orderId);
    if (existing) {
      throw new RecoveryActionError(
        `Order already has a refund action (${existing.id}, ${existing.status})`,
        409
      );
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

// One refund per order. Rejected refunds and ones that failed before money could
// move don't count. A FAILED refund with an unknown outcome (timeout, 5xx) still
// blocks, since PayPal may have processed it.
export function findOtherRefund(db: Database, orderId: string, exceptId?: string) {
  return Object.values(db.recoveryActions).find(
    (a) =>
      a.type === "REFUND_CAPTURE" &&
      a.orderId === orderId &&
      a.id !== exceptId &&
      a.status !== "REJECTED" &&
      !(a.status === "FAILED" && (a.result as { moneyMoved?: unknown } | null)?.moneyMoved === false)
  );
}

// "system" and "ai:<model>" can propose but never approve or execute.
export function isAutomatedActor(actor: string): boolean {
  return actor === "system" || actor.startsWith("ai:");
}
