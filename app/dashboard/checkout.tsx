"use client";

import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";
import { api } from "./api";

// Orders are created and captured through our own routes (not client-side
// actions.order.*) so the local record gets written the same way as the API flow.
export default function PayPalCheckout({
  clientId,
  amount,
  currency,
  onCaptured,
  onError,
}: {
  clientId: string;
  amount: string;
  currency: string;
  onCaptured: (orderId: string, captureStatus: string | undefined) => void;
  onError: (message: string) => void;
}) {
  return (
    // the SDK script is loaded per currency, so remount when it changes
    <PayPalScriptProvider key={currency} options={{ clientId, currency, intent: "capture" }}>
      <PayPalButtons
        style={{ layout: "horizontal", height: 40, tagline: false }}
        forceReRender={[amount, currency]}
        createOrder={async () => (await api.createOrder(amount, currency)).orderId}
        onApprove={async (data) => {
          const result = await api.captureOrder(data.orderID);
          onCaptured(result.orderId, result.captureStatus);
        }}
        onError={(err) => onError(err instanceof Error ? err.message : "PayPal checkout failed")}
      />
    </PayPalScriptProvider>
  );
}
