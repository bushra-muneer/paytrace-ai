import { createHash, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { approverPasscode } from "@/lib/config";

export const PASSCODE_HEADER = "x-paytrace-passcode";

// Returns a 401 response when a passcode is configured and the request doesn't match it.
export function rejectWithoutPasscode(request: Request): NextResponse | null {
  const expected = approverPasscode();
  if (!expected) return null;

  // hash both sides so the comparison is constant-time regardless of length
  const given = createHash("sha256").update(request.headers.get(PASSCODE_HEADER) ?? "").digest();
  const wanted = createHash("sha256").update(expected).digest();
  if (timingSafeEqual(given, wanted)) return null;

  return NextResponse.json({ success: false, error: "Approver passcode required" }, { status: 401 });
}
