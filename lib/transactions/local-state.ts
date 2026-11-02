import type { PaymentStatus, Transaction } from "@/lib/domain/types";
import { authoritativeStatus, isForwardTransition, latestCapture } from "@/lib/paypal/status";
import { toMoney, type PayPalOrder } from "@/lib/paypal/types";
import { withDb } from "@/lib/storage/store";

// Local order records written by create-order / capture-order.

export function recordOrderCreated(order: PayPalOrder): Promise<Transaction> {
  return upsert(order, "CREATED");
}

export function recordCaptureResult(order: PayPalOrder): Promise<Transaction> {
  return upsert(order, authoritativeStatus(order));
}

function upsert(order: PayPalOrder, status: PaymentStatus): Promise<Transaction> {
  return withDb((db) => {
    const now = new Date().toISOString();
    const capture = latestCapture(order);
    const existing = db.transactions[order.id];

    const transaction: Transaction = existing ?? {
      orderId: order.id,
      captureId: null,
      amount: toMoney(order.purchase_units?.[0]?.amount),
      localStatus: status,
      paypalStatus: null,
      lastReconciledAt: null,
      lastUpdatedBy: "api",
      createdAt: now,
      updatedAt: now,
    };

    transaction.captureId ??= capture?.id ?? null;
    transaction.amount ??= toMoney(capture?.amount ?? order.purchase_units?.[0]?.amount);

    // a webhook might have got here first, don't move backwards
    if (existing && isForwardTransition(existing.localStatus, status)) {
      transaction.localStatus = status;
      transaction.lastUpdatedBy = "api";
      transaction.updatedAt = now;
    }

    db.transactions[order.id] = transaction;
    return transaction;
  });
}
