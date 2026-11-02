import { NextRequest, NextResponse } from "next/server";
import { readDb } from "@/lib/storage/store";

// GET /api/incidents?status=OPEN|RESOLVED&orderId=
export async function GET(request: NextRequest) {
  const status = request.nextUrl.searchParams.get("status");
  const orderId = request.nextUrl.searchParams.get("orderId");

  const db = await readDb();
  const rows = Object.values(db.incidents)
    .filter((i) => (!status || i.status === status) && (!orderId || i.orderId === orderId))
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));

  return NextResponse.json({ rows });
}
