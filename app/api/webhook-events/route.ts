import { NextRequest, NextResponse } from "next/server";
import { rejectWithoutPasscode } from "@/lib/http/approver";
import { readDb } from "@/lib/storage/store";

// GET /api/webhook-events?orderId=&includePayload=true
// payload is left out by default since it's big
export async function GET(request: NextRequest) {
  const orderId = request.nextUrl.searchParams.get("orderId");
  const includePayload = request.nextUrl.searchParams.get("includePayload") === "true";
  // raw payloads carry buyer details (name, email, address)
  if (includePayload) {
    const denied = rejectWithoutPasscode(request);
    if (denied) return denied;
  }

  const db = await readDb();
  const rows = Object.values(db.webhookEvents)
    .filter((e) => !orderId || e.orderId === orderId)
    .sort((a, b) => b.lastReceivedAt.localeCompare(a.lastReceivedAt))
    .map(({ payload, ...row }) => (includePayload ? { ...row, payload } : row));

  return NextResponse.json({ rows });
}
