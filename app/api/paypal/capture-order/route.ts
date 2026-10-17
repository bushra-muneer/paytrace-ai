import { NextRequest, NextResponse } from "next/server";

const PAYPAL_BASE_URL =
  process.env.PAYPAL_BASE_URL || "https://api-m.sandbox.paypal.com";

async function getAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing PayPal credentials");
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    cache: "no-store",
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to get PayPal access token: ${errorText}`);
  }

  const data = await response.json();
  return data.access_token as string;
}

export async function POST(request: NextRequest) {
  try {
    let body;

try {
  body = await request.json();
} catch {
  return NextResponse.json(
    {
      success: false,
      error: "Request body must contain valid JSON",
    },
    { status: 400 }
  );
}

const orderId = body?.orderId;

if (!orderId) {
  return NextResponse.json(
    {
      success: false,
      error: "orderId is required",
    },
    { status: 400 }
  );
}

  
    const accessToken = await getAccessToken();

    const response = await fetch(
      `${PAYPAL_BASE_URL}/v2/checkout/orders/${orderId}/capture`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        cache: "no-store",
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("PayPal capture error:", data);

      return NextResponse.json(
        {
          success: false,
          error: "Failed to capture PayPal order",
          details: data,
        },
        { status: response.status }
      );
    }

    const capture =
      data.purchase_units?.[0]?.payments?.captures?.[0];

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