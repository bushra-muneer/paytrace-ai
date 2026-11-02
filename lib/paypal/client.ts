// server only (uses PAYPAL_CLIENT_SECRET)

export const PAYPAL_BASE_URL =
  process.env.PAYPAL_BASE_URL || "https://api-m.sandbox.paypal.com";

export class PayPalApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details: unknown
  ) {
    super(message);
    this.name = "PayPalApiError";
  }
}

let cachedToken: { value: string; expiresAt: number } | null = null;

export async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.value;
  }

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
    throw new PayPalApiError(
      "Failed to get PayPal access token",
      response.status,
      await safeJson(response)
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  // refresh a minute early
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return data.access_token;
}

export async function paypalRequest<T>(
  pathname: string,
  init: {
    method?: "GET" | "POST";
    body?: string;
    headers?: Record<string, string>;
  } = {}
): Promise<T> {
  const accessToken = await getAccessToken();

  const response = await fetch(`${PAYPAL_BASE_URL}${pathname}`, {
    method: init.method ?? "GET",
    headers: {
      ...init.headers,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: init.body,
    cache: "no-store",
  });

  const data = await safeJson(response);

  if (!response.ok) {
    throw new PayPalApiError(
      `PayPal request failed: ${init.method ?? "GET"} ${pathname}`,
      response.status,
      data
    );
  }

  return data as T;
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}
