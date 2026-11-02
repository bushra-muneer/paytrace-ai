import { NextRequest, NextResponse } from "next/server";
import { PayPalApiError, paypalRequest } from "@/lib/paypal/client";
import type { PayPalOrder } from "@/lib/paypal/types";

export async function GET(request: NextRequest) {
  try {
    const orderId = request.nextUrl.searchParams.get("orderId");

    if (!orderId) {
      return NextResponse.json(
        { error: "orderId is required" },
        { status: 400 }
      );
    }

    const order = await paypalRequest<PayPalOrder>(
      `/v2/checkout/orders/${encodeURIComponent(orderId)}`
    );

    return NextResponse.json(order);
  } catch (error) {
    if (error instanceof PayPalApiError) {
      return NextResponse.json(error.details, { status: error.status });
    }
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
