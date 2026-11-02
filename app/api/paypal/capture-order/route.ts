import { NextRequest, NextResponse } from "next/server";
import { invalidJson, readJsonBody } from "@/lib/http/responses";
import { PayPalApiError, paypalRequest } from "@/lib/paypal/client";
import { latestCapture } from "@/lib/paypal/status";
import type { PayPalOrder } from "@/lib/paypal/types";
import { recordCaptureResult } from "@/lib/transactions/local-state";

export async function POST(request: NextRequest) {
  const body = await readJsonBody<{ orderId?: unknown }>(request);
  if (!body) return invalidJson();

  const orderId = body.orderId;
  if (!orderId || typeof orderId !== "string") {
    return NextResponse.json({ success: false, error: "orderId is required" }, { status: 400 });
  }

  try {
    const data = await paypalRequest<PayPalOrder>(
      `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      {
        method: "POST",
        headers: { Prefer: "return=representation" },
      }
    );

    await recordCaptureResult(data).catch((error) =>
      console.error(`Failed to record local capture for ${orderId}:`, error)
    );

    const capture = latestCapture(data);

    return NextResponse.json({
      success: true,
      orderId: data.id,
      orderStatus: data.status,
      captureId: capture?.id,
      captureStatus: capture?.status,
      amount: capture?.amount,
      order: data,
    });
  } catch (error) {
    if (error instanceof PayPalApiError) {
      console.error("PayPal capture error:", error.details);

      return NextResponse.json(
        {
          success: false,
          error: "Failed to capture PayPal order",
          details: error.details,
        },
        { status: error.status }
      );
    }

    console.error("Capture order error:", error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
