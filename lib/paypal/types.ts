// Only the PayPal fields we actually read.

import type { Money } from "@/lib/domain/types";

export interface PayPalLink {
  href: string;
  rel: string;
  method?: string;
}

export interface PayPalWebhookResource {
  id?: string;
  status?: string;
  update_time?: string;
  invoice_id?: string;
  amount?: { currency_code: string; value: string };
  links?: PayPalLink[];
  supplementary_data?: {
    related_ids?: { order_id?: string; capture_id?: string };
  };
  purchase_units?: PayPalPurchaseUnit[];
}

export interface PayPalWebhookEvent {
  id: string;
  event_type: string;
  resource_type?: string;
  create_time?: string;
  summary?: string;
  resource: PayPalWebhookResource;
}

export interface PayPalCapture {
  id: string;
  status: string;
  amount: { currency_code: string; value: string };
}

export interface PayPalPurchaseUnit {
  amount?: { currency_code: string; value: string };
  payments?: {
    captures?: PayPalCapture[];
    refunds?: PayPalRefund[];
  };
}

export interface PayPalRefund {
  id: string;
  status: string;
  amount?: { currency_code: string; value: string };
  invoice_id?: string;
}

export interface PayPalOrder {
  id: string;
  status: string;
  purchase_units?: PayPalPurchaseUnit[];
  links?: PayPalLink[];
}

export function toMoney(
  amount: { currency_code: string; value: string } | undefined
): Money | null {
  return amount ? { currency: amount.currency_code, value: amount.value } : null;
}
