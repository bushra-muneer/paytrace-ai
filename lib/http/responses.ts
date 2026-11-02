import { NextResponse } from "next/server";
import { InvestigationError } from "@/lib/ai/investigator";
import { PayPalApiError } from "@/lib/paypal/client";
import { RecoveryActionError } from "@/lib/recovery/propose";

// empty body -> {}, bad JSON -> null
export async function readJsonBody<T extends object>(request: Request): Promise<T | null> {
  const text = await request.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function invalidJson() {
  return NextResponse.json(
    { success: false, error: "Request body must contain valid JSON" },
    { status: 400 }
  );
}

export function errorResponse(error: unknown, context: string) {
  if (error instanceof RecoveryActionError || error instanceof InvestigationError) {
    return NextResponse.json({ success: false, error: error.message }, { status: error.status });
  }
  if (error instanceof PayPalApiError) {
    return NextResponse.json(
      { success: false, error: error.message, details: error.details },
      { status: error.status === 404 ? 404 : 502 }
    );
  }
  console.error(`${context}:`, error);
  return NextResponse.json(
    { success: false, error: error instanceof Error ? error.message : "Unknown error" },
    { status: 500 }
  );
}
