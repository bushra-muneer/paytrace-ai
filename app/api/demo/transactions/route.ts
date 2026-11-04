import { NextRequest, NextResponse } from "next/server";
import { demoToolsEnabled } from "@/lib/config";
import type { Money, PaymentStatus, Transaction } from "@/lib/domain/types";
import { rejectWithoutPasscode } from "@/lib/http/approver";
import { invalidJson, readJsonBody } from "@/lib/http/responses";
import { withDb } from "@/lib/storage/store";

const STAGEABLE: ReadonlySet<string> = new Set<PaymentStatus>(["CREATED", "APPROVED", "PENDING", "COMPLETED", "REFUNDED"]);

// Demo tool: force a local status to stage an incident, e.g. pretend the app
// crashed after PayPal captured the payment: { "orderId": "...", "localStatus": "PENDING" }
export async function POST(request: NextRequest) {
  if (!demoToolsEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const denied = rejectWithoutPasscode(request);
  if (denied) return denied;

  const body = await readJsonBody<{ orderId?: string; localStatus?: PaymentStatus; amount?: Money }>(request);
  if (!body) return invalidJson();

  if (!body.orderId || !body.localStatus || !STAGEABLE.has(body.localStatus)) {
    return NextResponse.json(
      { success: false, error: `orderId and localStatus (${[...STAGEABLE].join(", ")}) are required` },
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
