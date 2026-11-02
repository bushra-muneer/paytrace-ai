import { NextResponse } from "next/server";
import { readDb } from "@/lib/storage/store";

export async function GET() {
  const db = await readDb();
  const rows = Object.values(db.transactions).sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  );
  return NextResponse.json({ rows });
}
