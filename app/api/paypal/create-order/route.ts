import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { invalidJson, readJsonBody } from "@/lib/http/responses";
import { PayPalApiError, paypalRequest } from "@/lib/paypal/client";
import type { PayPalOrder } from "@/lib/paypal/types";
import { recordOrderCreated } from "@/lib/transactions/local-state";

// body is optional, defaults to EUR 10.00
export async function POST(request: NextRequest) {
  const body = await readJsonBody<{ amount?: unknown; currency?: unknown }>(request);
  if (!body) return invalidJson();

  const amount = body.amount === undefined ? "10.00" : String(body.amount);
  const currency = body.currency === undefined ? "EUR" : String(body.currency).toUpperCase();

  if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) {
    return NextResponse.json(
      { success: false, error: "amount must be a positive decimal like 10.00" },
      { status: 400 }
    );
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    return NextResponse.json(
      { success: false, error: "currency must be a 3-letter ISO code" },
      { status: 400 }
    );
  }

  try {
    const order = await paypalRequest<PayPalOrder>("/v2/checkout/orders", {
      method: "POST",
      headers: { "PayPal-Request-Id": randomUUID(), Prefer: "return=representation" },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          { amount: { currency_code: currency, value: Number(amount).toFixed(2) } },
        ],
      }),
    });

    // don't fail the request if only the local write breaks, reconcile will flag it
    await recordOrderCreated(order).catch((error) =>
      console.error(`Failed to record local order ${order.id}:`, error)
    );

    const approveUrl =
      order.links?.find((l) => l.rel === "approve" || l.rel === "payer-action")?.href ?? null;

    return NextResponse.json({
      success: true,
      orderId: order.id,
      status: order.status,
      approveUrl,
      order,
    });
  } catch (error) {
    if (error instanceof PayPalApiError) {
      console.error("PayPal create order error:", error.details);
      return NextResponse.json(
        { success: false, error: "Failed to create PayPal order", details: error.details },
        { status: error.status }
      );
    }
    console.error("Create order error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
