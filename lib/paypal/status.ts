import type { PaymentStatus } from "@/lib/domain/types";
import type { PayPalCapture, PayPalOrder } from "@/lib/paypal/types";

const ORDER_STATUS: Record<string, PaymentStatus> = {
  CREATED: "CREATED",
  SAVED: "CREATED",
  PAYER_ACTION_REQUIRED: "CREATED",
  APPROVED: "APPROVED",
  COMPLETED: "COMPLETED",
  VOIDED: "VOIDED",
};

const CAPTURE_STATUS: Record<string, PaymentStatus> = {
  PENDING: "PENDING",
  COMPLETED: "COMPLETED",
  DECLINED: "DECLINED",
  FAILED: "DECLINED",
  PARTIALLY_REFUNDED: "PARTIALLY_REFUNDED",
  REFUNDED: "REFUNDED",
};

// used to skip events that arrive late, e.g. ORDER.APPROVED after CAPTURE.COMPLETED
const STATUS_RANK: Record<PaymentStatus, number> = {
  UNKNOWN: -1,
  CREATED: 0,
  APPROVED: 1,
  PENDING: 2,
  COMPLETED: 3,
  DECLINED: 3,
  VOIDED: 3,
  PARTIALLY_REFUNDED: 4,
  REFUNDED: 5,
  REVERSED: 5,
};

export function isForwardTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return from !== to && STATUS_RANK[to] >= STATUS_RANK[from];
}

// merchant has the money
export const FUNDS_CAPTURED: ReadonlySet<PaymentStatus> = new Set([
  "COMPLETED",
  "PARTIALLY_REFUNDED",
]);

// no money moved yet
export const PRE_CAPTURE: ReadonlySet<PaymentStatus> = new Set([
  "CREATED",
  "APPROVED",
  "PENDING",
]);

export function latestCapture(order: PayPalOrder): PayPalCapture | null {
  const captures = order.purchase_units?.flatMap((u) => u.payments?.captures ?? []) ?? [];
  return captures.at(-1) ?? null;
}

// The order status stays COMPLETED after capture, so prefer the capture status
// when there is one (it shows pending/refunded etc).
export function authoritativeStatus(order: PayPalOrder): PaymentStatus {
  const capture = latestCapture(order);
  if (capture) return CAPTURE_STATUS[capture.status] ?? "UNKNOWN";
  return ORDER_STATUS[order.status] ?? "UNKNOWN";
}

export function statusFromEventType(eventType: string): PaymentStatus | null {
  switch (eventType) {
    case "CHECKOUT.ORDER.APPROVED":
      return "APPROVED";
    case "CHECKOUT.ORDER.COMPLETED":
    case "PAYMENT.CAPTURE.COMPLETED":
      return "COMPLETED";
    case "PAYMENT.CAPTURE.PENDING":
      return "PENDING";
    case "PAYMENT.CAPTURE.DENIED":
    case "PAYMENT.CAPTURE.DECLINED":
      return "DECLINED";
    case "PAYMENT.CAPTURE.REFUNDED":
      // could be partial, process.ts checks the amount
      return "REFUNDED";
    case "PAYMENT.CAPTURE.REVERSED":
      return "REVERSED";
    default:
      return null;
  }
}
