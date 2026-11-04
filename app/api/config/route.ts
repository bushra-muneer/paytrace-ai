import { NextResponse } from "next/server";
import { approverPasscode, demoToolsEnabled } from "@/lib/config";

// read env at request time, not at build time
export const dynamic = "force-dynamic";

// Public settings for the dashboard. The PayPal client id is meant to be public
// (the JS SDK loads with it); the secret never leaves the server.
export function GET() {
  return NextResponse.json({
    paypalClientId: process.env.PAYPAL_CLIENT_ID ?? null,
    demoTools: demoToolsEnabled(),
    passcodeRequired: approverPasscode() !== null,
  });
}
