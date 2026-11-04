// Shared types. Kept flat on purpose so rows can go straight into AG Grid.

export type PaymentStatus =
  | "CREATED"
  | "APPROVED"
  | "PENDING"
  | "COMPLETED"
  | "DECLINED"
  | "REFUNDED"
  | "PARTIALLY_REFUNDED"
  | "REVERSED"
  | "VOIDED"
  | "UNKNOWN";

export interface Money {
  currency: string;
  value: string; // keep PayPal's decimal string, e.g. "10.00"
}

// Our side of a payment, one per PayPal order
export interface Transaction {
  orderId: string;
  captureId: string | null;
  amount: Money | null;
  localStatus: PaymentStatus;
  paypalStatus: PaymentStatus | null; // last value seen from the PayPal API
  lastReconciledAt: string | null;
  lastUpdatedBy: "webhook" | "api" | "manual" | "seed";
  // newest PayPal resource update_time applied from a webhook; older events are ignored
  lastEventUpdateTime?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type WebhookVerificationResult = "VERIFIED" | "SIMULATED_VERIFIED";

// IGNORED = valid event but nothing to change, FAILED = will be retried
export type WebhookProcessingStatus = "PROCESSED" | "IGNORED" | "FAILED";

export interface WebhookEventRecord {
  eventId: string;
  eventType: string;
  resourceType: string | null;
  resourceId: string | null;
  orderId: string | null;
  captureId: string | null;
  refundId: string | null;
  amount: Money | null;
  resourceStatus: string | null;
  verification: WebhookVerificationResult;
  processingStatus: WebhookProcessingStatus;
  processingError: string | null;
  deliveryCount: number;
  eventCreatedAt: string | null;
  firstReceivedAt: string;
  lastReceivedAt: string;
  payload: unknown;
}

export type IncidentType = "STATE_MISMATCH" | "MISSING_LOCAL_RECORD" | "AMOUNT_MISMATCH";

export type IncidentSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type IncidentStatus = "OPEN" | "RESOLVED";

export interface IncidentEvidence {
  source: "paypal_api" | "local_db" | "webhook";
  reference: string;
  observedAt: string;
  detail: string;
  data?: unknown;
}

export interface Incident {
  id: string;
  fingerprint: string; // type:orderId, so we don't open the same incident twice
  type: IncidentType;
  severity: IncidentSeverity;
  status: IncidentStatus;
  orderId: string;
  captureId: string | null;
  paypalStatus: PaymentStatus | null;
  localStatus: PaymentStatus | null;
  summary: string;
  financialImpact: Money | null;
  evidence: IncidentEvidence[];
  aiAnalysis: AiAnalysis | null;
  detectedAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
}

export type Confidence = "LOW" | "MEDIUM" | "HIGH";

export interface AiAnalysis {
  model: string;
  generatedAt: string;
  rootCause: string;
  explanation: string;
  confidence: Confidence;
  evidenceAssessment: { reference: string; interpretation: string }[];
  financialImpact: {
    summary: string;
    amountAtRisk: string | null;
    currency: string | null;
  };
  customerImpact: string;
  recommendedActions: {
    type: RecoveryActionType | "MANUAL_INVESTIGATION";
    description: string;
    risk: Confidence;
  }[];
  proposedActionIds: string[];
}

export type RecoveryActionType = "SYNC_LOCAL_STATUS" | "CREATE_LOCAL_RECORD" | "REFUND_CAPTURE";

export type RecoveryActionStatus =
  | "PROPOSED"
  | "APPROVED"
  | "REJECTED"
  | "EXECUTING"
  | "EXECUTED"
  | "FAILED"
  // refund sent but the outcome is unknown (timeout, 5xx, request still in progress);
  // can only be retried with the same PayPal-Request-Id
  | "UNCERTAIN";

// Identity of one refund operation, fixed at approval and reused on every retry.
export interface RefundOperation {
  requestId: string; // PayPal-Request-Id
  invoiceId: string; // sent as invoice_id, used to find the refund at PayPal later
  attempts: number;
  lastAttemptAt: string | null;
  refundId: string | null;
  refundStatus: string | null;
}

export interface AuditEntry {
  at: string;
  actor: string;
  event: string;
  detail: string | null;
}

export interface RecoveryAction {
  id: string;
  incidentId: string;
  orderId: string;
  captureId: string | null;
  type: RecoveryActionType;
  status: RecoveryActionStatus;
  financial: boolean; // true for refunds
  params: {
    targetStatus?: PaymentStatus;
    amount?: Money; // no amount = full refund
  };
  rationale: string;
  proposedBy: string; // "system", "ai:<model>" or a person
  proposedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  executedAt: string | null;
  result: unknown | null;
  error: string | null;
  refundOperation?: RefundOperation | null; // refunds only, set when approved
  audit: AuditEntry[];
}
