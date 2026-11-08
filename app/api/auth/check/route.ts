import { NextRequest, NextResponse } from "next/server";
import { rejectWithoutPasscode } from "@/lib/http/approver";

// Lets the dashboard confirm a passcode before someone tries to approve with it.
export function POST(request: NextRequest) {
  return rejectWithoutPasscode(request) ?? NextResponse.json({ success: true });
}
