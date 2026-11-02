import { NextRequest, NextResponse } from "next/server";
import type { Money, PaymentStatus, Transaction } from "@/lib/domain/types";
import { invalidJson, readJsonBody } from "@/lib/http/responses";
import { withDb } from "@/lib/storage/store";

// Dev only: force a local status to reproduce incidents.
// e.g. { "orderId": "...", "localStatus": "PENDING" } then call /api/reconcile
export async function POST(request: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await readJsonBody<{ orderId?: string; localStatus?: PaymentStatus; amount?: Money }>(request);
  if (!body) return invalidJson();

  if (!body.orderId || !body.localStatus) {
    return NextResponse.json(
      { success: false, error: "orderId and localStatus are required" },
      { status: 400 }
    );
  }

  const { orderId, localStatus, amount } = body;
  const transaction = await withDb((db) => {
    const now = new Date().toISOString();
    const existing = db.transactions[orderId];
    const next: Transaction = {
      orderId,
      captureId: existing?.captureId ?? null,
      amount: amount ?? existing?.amount ?? null,
      localStatus,
      paypalStatus: existing?.paypalStatus ?? null,
      lastReconciledAt: existing?.lastReconciledAt ?? null,
      lastUpdatedBy: "seed",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    db.transactions[orderId] = next;
    return next;
  });

  return NextResponse.json({ success: true, transaction });
}
