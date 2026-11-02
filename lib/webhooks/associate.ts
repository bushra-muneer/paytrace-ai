import type { PayPalWebhookEvent } from "@/lib/paypal/types";

export interface EventAssociation {
  orderId: string | null;
  captureId: string | null;
  refundId: string | null;
}

// Where the ids live depends on resource_type:
//   checkout-order: resource.id is the order
//   capture: resource.id is the capture, order is in supplementary_data.related_ids
//   refund: resource.id is the refund, capture is in the "up" link
export function associateEvent(event: PayPalWebhookEvent): EventAssociation {
  const resource = event.resource ?? {};
  const related = resource.supplementary_data?.related_ids;
  const resourceType = event.resource_type?.toLowerCase();

  const fromLink = (pattern: RegExp) => {
    for (const link of resource.links ?? []) {
      const match = link.href.match(pattern);
      if (match) return match[1];
    }
    return null;
  };

  const orderId =
    (resourceType === "checkout-order" ? resource.id : undefined) ??
    related?.order_id ??
    fromLink(/\/v2\/checkout\/orders\/([^/?]+)/);

  const captureId =
    (resourceType === "capture" ? resource.id : undefined) ??
    related?.capture_id ??
    fromLink(/\/v2\/payments\/captures\/([^/?]+)/);

  const refundId = resourceType === "refund" ? (resource.id ?? null) : null;

  return {
    orderId: orderId ?? null,
    captureId: captureId ?? null,
    refundId,
  };
}
