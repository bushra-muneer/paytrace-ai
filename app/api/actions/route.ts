import { NextRequest, NextResponse } from "next/server";
import { readDb } from "@/lib/storage/store";

// GET /api/actions?status=&orderId=
export async function GET(request: NextRequest) {
  const status = request.nextUrl.searchParams.get("status");
  const orderId = request.nextUrl.searchParams.get("orderId");

  const db = await readDb();
  const rows = Object.values(db.recoveryActions)
    .filter((a) => (!status || a.status === status) && (!orderId || a.orderId === orderId))
    .sort((a, b) => b.proposedAt.localeCompare(a.proposedAt));

  return NextResponse.json({ rows });
}
