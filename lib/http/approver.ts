import { createHash, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { approverPasscode } from "@/lib/config";

export const PASSCODE_HEADER = "x-paytrace-passcode";

// Wrong guesses allowed per client address before it has to wait.
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;

// In memory, so it resets on restart; enough to stop online guessing on a single instance.
const failures = new Map<string, { count: number; resetAt: number }>();

function clientKey(request: Request): string {
  // The proxy in front of us appends the real client address last. Earlier entries come
  // from the client and could be faked to dodge the limit, so they're ignored.
  return request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "unknown";
}

// Returns an error response when a passcode is configured and the request doesn't carry it.
export function rejectWithoutPasscode(request: Request): NextResponse | null {
  const expected = approverPasscode();
  if (!expected) return null;

  const key = clientKey(request);
  const now = Date.now();
  const record = failures.get(key);
  if (record && record.resetAt <= now) failures.delete(key);

  const blocked = failures.get(key);
  if (blocked && blocked.count >= MAX_FAILURES) {
    const minutes = Math.ceil((blocked.resetAt - now) / 60_000);
    return NextResponse.json(
      { success: false, error: `Too many wrong passcodes. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` },
      { status: 429, headers: { "Retry-After": String(Math.ceil((blocked.resetAt - now) / 1000)) } }
    );
  }

  const supplied = request.headers.get(PASSCODE_HEADER) ?? "";
  // hash both sides so the comparison is constant-time regardless of length
  const given = createHash("sha256").update(supplied).digest();
  const wanted = createHash("sha256").update(expected).digest();
  if (timingSafeEqual(given, wanted)) {
    failures.delete(key);
    return null;
  }

  // only actual guesses count; a visitor who never entered a passcode isn't locked out
  if (supplied) {
    const current = failures.get(key) ?? { count: 0, resetAt: now + WINDOW_MS };
    current.count += 1;
    failures.set(key, current);
  }
  return NextResponse.json({ success: false, error: "Approver passcode required" }, { status: 401 });
}
