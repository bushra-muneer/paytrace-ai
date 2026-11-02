import { after, NextRequest, NextResponse } from "next/server";
import type { PayPalWebhookEvent } from "@/lib/paypal/types";
import { verifyWebhookRequest } from "@/lib/paypal/webhook-verification";
import { reconcileOrder } from "@/lib/reconciliation/reconcile";
import { processWebhookEvent, recordFailedWebhookEvent } from "@/lib/webhooks/process";

// PayPal retries anything that isn't a 2xx, so only return errors we want retried
// (or that are the sender's fault).
export async function POST(request: NextRequest) {
  // need the raw text for signature verification
  const rawBody = await request.text();

  let event: PayPalWebhookEvent;
  try {
    event = JSON.parse(rawBody) as PayPalWebhookEvent;
  } catch {
    return NextResponse.json(
      { success: false, error: "Request body must contain valid JSON" },
      { status: 400 }
    );
  }

  if (!event?.id || !event?.event_type) {
    return NextResponse.json(
      { success: false, error: "Not a PayPal webhook event (missing id or event_type)" },
      { status: 400 }
    );
  }

  const verification = await verifyWebhookRequest(request.headers, rawBody);
  if (!verification.ok) {
    console.warn(`Webhook ${event.id} rejected: ${verification.reason}`);
    return NextResponse.json(
      { success: false, error: "Webhook signature verification failed" },
      { status: 401 }
    );
  }

  try {
    const result = await processWebhookEvent(event, verification.result);

    const orderId = result.event.orderId;
    if (!result.duplicate && orderId && process.env.PAYTRACE_AUTO_RECONCILE !== "false") {
      after(async () => {
        try {
          await reconcileOrder(orderId);
        } catch (error) {
          console.error(`Auto-reconcile failed for order ${orderId}:`, error);
        }
      });
    }

    return NextResponse.json({
      success: true,
      duplicate: result.duplicate,
      eventId: result.event.eventId,
      eventType: result.event.eventType,
      processingStatus: result.event.processingStatus,
      processingNote: result.event.processingError,
      orderId,
      captureId: result.event.captureId,
      localStatus: result.transaction?.localStatus ?? null,
    });
  } catch (error) {
    console.error(`Webhook ${event.id} processing failed:`, error);
    await recordFailedWebhookEvent(event, verification.result, error).catch((e) =>
      console.error("Failed to record failed webhook event:", e)
    );
    return NextResponse.json(
      { success: false, error: "Webhook processing failed" },
      { status: 500 }
    );
  }
}
