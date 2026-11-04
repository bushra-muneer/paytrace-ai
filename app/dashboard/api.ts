import type {
  Incident,
  PaymentStatus,
  RecoveryAction,
  Transaction,
  WebhookEventRecord,
} from "@/lib/domain/types";

export type EventRow = Omit<WebhookEventRecord, "payload">;

export interface IncidentDetail {
  incident: Incident;
  transaction: Transaction | null;
  events: EventRow[];
  actions: RecoveryAction[];
}

export interface AppConfig {
  paypalClientId: string | null;
  demoTools: boolean;
  passcodeRequired: boolean;
}

export class ApiError extends Error {}

let passcode = "";
export function setPasscode(value: string) {
  passcode = value;
}

async function call<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.body) headers["Content-Type"] = "application/json";
  if (passcode) headers["x-paytrace-passcode"] = passcode;

  const response = await fetch(url, {
    method: init?.method ?? "GET",
    headers,
    body: init?.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    throw new ApiError(data.error ?? `Request failed (${response.status})`);
  }
  return data as T;
}

const rows = <T,>(url: string) => call<{ rows: T[] }>(url).then((d) => d.rows);

export const api = {
  config: () => call<AppConfig>("/api/config"),
  transactions: () => rows<Transaction>("/api/transactions"),
  events: () => rows<EventRow>("/api/webhook-events"),
  incidents: () => rows<Incident>("/api/incidents"),
  actions: () => rows<RecoveryAction>("/api/actions"),
  incident: (id: string) => call<IncidentDetail>(`/api/incidents/${id}`),

  reconcileAll: () =>
    call<{ reconciled: number; inSync: number; errors: { orderId: string; error: string }[] }>("/api/reconcile", {
      method: "POST",
      body: {},
    }),
  reconcile: (orderId: string) =>
    call<{ openIncidents: Incident[] }>("/api/reconcile", { method: "POST", body: { orderId } }),
  investigate: (id: string) => call(`/api/incidents/${id}/investigate`, { method: "POST" }),

  createOrder: (amount: string, currency: string) =>
    call<{ orderId: string; approveUrl: string | null }>("/api/paypal/create-order", {
      method: "POST",
      body: { amount, currency },
    }),
  captureOrder: (orderId: string) =>
    call<{ orderId: string; captureStatus?: string }>("/api/paypal/capture-order", {
      method: "POST",
      body: { orderId },
    }),
  stageLocalStatus: (orderId: string, localStatus: PaymentStatus) =>
    call("/api/demo/transactions", { method: "POST", body: { orderId, localStatus } }),

  decide: (
    id: string,
    operation: "approve" | "reject" | "execute",
    body: { actor: string; note?: string; acknowledgeFinancialImpact?: boolean }
  ) => call<{ action: RecoveryAction }>(`/api/actions/${id}/${operation}`, { method: "POST", body }),
};
