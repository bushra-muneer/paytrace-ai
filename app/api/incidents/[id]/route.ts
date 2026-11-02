import { NextRequest, NextResponse } from "next/server";
import { readDb } from "@/lib/storage/store";

export async function GET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = await readDb();
  const incident = db.incidents[id];

  if (!incident) {
    return NextResponse.json({ success: false, error: "Incident not found" }, { status: 404 });
  }

  return NextResponse.json({
    incident,
    transaction: db.transactions[incident.orderId] ?? null,
    events: Object.values(db.webhookEvents)
      .filter((e) => e.orderId === incident.orderId)
      .sort((a, b) => a.firstReceivedAt.localeCompare(b.firstReceivedAt))
      .map((e) => ({ ...e, payload: undefined })),
    actions: Object.values(db.recoveryActions)
      .filter((a) => a.incidentId === incident.id)
      .sort((a, b) => b.proposedAt.localeCompare(a.proposedAt)),
  });
}
